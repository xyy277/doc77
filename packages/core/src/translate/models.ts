/**
 * Model definitions for offline translation.
 */
export interface ModelPair {
  repoId: string;
  sourceLang: string;
  targetLang: string;
  displayName: string;
  size: string;
}

export const MODEL_PAIRS: Record<string, ModelPair> = {
  'en-zh': {
    repoId: 'Xenova/opus-mt-en-zh',
    sourceLang: 'en',
    targetLang: 'zh',
    displayName: 'English → 中文',
    size: '~80MB',
  },
  'zh-en': {
    repoId: 'Xenova/opus-mt-zh-en',
    sourceLang: 'zh',
    targetLang: 'en',
    displayName: '中文 → English',
    size: '~80MB',
  },
};
