/**
 * Translation engine — wraps @huggingface/transformers.js with lazy loading.
 * WASM backend only (onnxruntime-web). No native onnxruntime-node.
 */
import * as path from 'node:path';
import * as os from 'node:os';

export interface TranslationResult {
  translated_text: string;
  source_lang: string;
  target_lang: string;
  model: string;
  duration_ms: number;
}

// ── Lazy import ─────────────────────────────────────────────────────────

let _TransformersModule: any = null;

async function getTransformers() {
  if (_TransformersModule) return _TransformersModule;
  try {
    _TransformersModule = await import('@huggingface/transformers');
  } catch {
    return null;
  }
  return _TransformersModule;
}

// ── Env configuration ───────────────────────────────────────────────────

let _envBaseConfigured = false;

function configureEnvBase(tf: any): void {
  if (_envBaseConfigured) return;
  tf.env.cacheDir = path.join(os.homedir(), '.doc77', 'translate-models');
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = true;
  _envBaseConfigured = true;
}

async function configureEnvMirror(tf: any): Promise<void> {
  try {
    const { getConfig } = await import('../db/config.js');
    tf.env.remoteHost =
      getConfig('translate.mirror') === 'true'
        ? 'https://hf-mirror.com/'
        : 'https://huggingface.co/';
  } catch {
    // No DB available — use default
  }
}

// ── Pipeline cache ──────────────────────────────────────────────────────

const pipelineCache = new Map<string, any>();
const pipelineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PIPELINE_IDLE_MS = 5 * 60 * 1000;

async function getPipeline(modelRepoId: string): Promise<any> {
  if (pipelineCache.has(modelRepoId)) {
    const t = pipelineTimers.get(modelRepoId);
    if (t) clearTimeout(t);
    pipelineTimers.set(
      modelRepoId,
      setTimeout(() => disposePipeline(modelRepoId), PIPELINE_IDLE_MS),
    );
    return pipelineCache.get(modelRepoId);
  }

  const tf = await getTransformers();
  if (!tf) throw new Error('ENGINE_UNAVAILABLE');
  configureEnvBase(tf);
  await configureEnvMirror(tf);

  const pipe = await tf.pipeline('translation', modelRepoId, { quantized: true });
  pipelineCache.set(modelRepoId, pipe);
  pipelineTimers.set(
    modelRepoId,
    setTimeout(() => disposePipeline(modelRepoId), PIPELINE_IDLE_MS),
  );
  return pipe;
}

function disposePipeline(modelRepoId: string): void {
  const pipe = pipelineCache.get(modelRepoId);
  if (pipe && typeof pipe.dispose === 'function') pipe.dispose();
  pipelineCache.delete(modelRepoId);
  pipelineTimers.delete(modelRepoId);
}

// ── Mutex ───────────────────────────────────────────────────────────────

let _translateLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    _translateLock = _translateLock.then(() => fn().then(resolve, reject));
  });
}

// ── Public API ──────────────────────────────────────────────────────────

export async function isEngineAvailable(): Promise<boolean> {
  return (await getTransformers()) !== null;
}

export async function isModelReady(pair: string): Promise<boolean> {
  const { MODEL_PAIRS } = await import('./models.js');
  const info = MODEL_PAIRS[pair];
  if (!info) return false;

  const tf = await getTransformers();
  if (!tf) return false;
  configureEnvBase(tf);

  const fs = await import('node:fs');
  const modelDir = path.join(
    os.homedir(),
    '.doc77',
    'translate-models',
    info.repoId.replace('/', path.sep),
  );
  return fs.existsSync(modelDir);
}

export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<TranslationResult> {
  const { MODEL_PAIRS } = await import('./models.js');

  let modelInfo = MODEL_PAIRS[`${sourceLang}-${targetLang}`];
  if (!modelInfo) {
    const candidates = Object.values(MODEL_PAIRS).filter(
      (m) => m.sourceLang === sourceLang || sourceLang === 'auto',
    );
    if (candidates.length > 0) modelInfo = candidates[0];
  }
  if (!modelInfo) throw new Error(`Unsupported language pair: ${sourceLang} → ${targetLang}`);

  const startTime = Date.now();

  return withLock(async () => {
    const pipe = await getPipeline(modelInfo!.repoId);
    const result = await pipe(text);
    const duration = Date.now() - startTime;

    const translated =
      Array.isArray(result) && result[0]?.translation_text
        ? result[0].translation_text
        : typeof result === 'string'
          ? result
          : JSON.stringify(result);

    return {
      translated_text: translated,
      source_lang: modelInfo!.sourceLang,
      target_lang: modelInfo!.targetLang,
      model: modelInfo!.repoId,
      duration_ms: duration,
    };
  });
}
