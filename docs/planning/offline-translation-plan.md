# doc77 离线翻译能力 — 实施方案

> **状态:提案(Proposal),待评审** — 由对话调研 + Explore/Plan agent 产出,尚未开工。评审通过后再排期实施。
> **创建日期:** 2026-07-13

## Context（为什么做 / 目标）

用户提出:doc77 的 Electron 版是否应增加"离线翻译"选项,把开源翻译模型打包进去(最初设想 LibreTranslate)。

调研后确认的现状:
- doc77 是 pnpm workspace monorepo。**Electron 版**(`packages/electron`)是内嵌 `@doc77/core` Express server、加载纯静态 HTML+JS 前端的桌面壳,已有三平台(Win/Mac/Linux)`electron-builder` 打包与 CI。
- **翻译能力当前完全不存在**。`@doc77/ai` 只接远程 OpenAI 兼容 API(默认 DeepSeek),无任何本地模型。
- 已有 `vendor-install`(`packages/core/src/server/vendor.ts`)—— 现成的"下载资源供离线使用"基建。

**用户已明确的产品分层(关键约束):**
- **`@doc77/ai`(远程 LLM)** = 面向**专业用户**的可选增强(质量优先)。
- **离线小模型翻译** = 面向**广大普通用户的日常使用**(翻译几个单词、短文),**不追求极致质量**,主打免费 + 断网可用 + 内容不出本机,降低推广门槛。默认主打 **英↔中(en-zh / zh-en)**。
- **离线小模型会占包体积**,因此发行分两档:
  - **精简版(Lite)** — 只有预览功能;ai、翻译**可拓展**(运行时按需安装)。
  - **完整版(Full)** — 包内**自带全部模块**(预览 + ai + 翻译引擎 + 默认模型),开箱即用。

**三个已定的技术决策:**
1. 引擎用 **transformers.js + Opus-MT ONNX(int8 量化)**,**不用 LibreTranslate**(它是 Python/Flask,跨三平台打 Python runtime 成本过高,与现有干净的 Node/Electron 进程模型冲突)。
2. 模型**按需下载,不强制打进安装包**,复用 `vendor-install` 模式(Full 版可预置默认模型,见决策 3)。
3. **双版本发行**:同一份代码,两个 electron-builder 打包变体,靠运行时 `_capabilities` 能力探测复用同一套 UI。

**预期结果:** 用户在预览页可对整篇文档或选中文本做本机离线翻译。Lite 版轻量、翻译/ai 按需装;Full 版开箱即用。npm CLI 基础包(`@doc77/core`)保持轻量,翻译作为可选能力懒加载。

---

## 关键架构决策(在 Plan agent 基础上的修正)

### 决策 1:运行时后端 = WASM 后端(不用 onnxruntime-node)
- `electron-builder.yml` 现在**没有任何 `asarUnpack`**,项目刻意规避原生模块(见 `docs/planning/ci-electron-lessons.md` 关于 electron-builder + pnpm 的坑)。`onnxruntime-node` 会引入 `*.node`,需要跨三平台 `asarUnpack`,重新踩已稳定的 CI 雷。
- WASM 慢 2-3x,但对"日常可用的可选功能"完全够用(int8 opus-mt 翻译一页约几秒)。`.wasm` 可在 asar 内正常读取,无需 `asarUnpack`。

### 决策 2:依赖放置 = 懒加载,core 保持轻量(**修正 Plan agent**)
Plan agent 建议把 `@xenova/transformers` 设为 `@doc77/core` 的硬依赖。**不采纳** —— core 会作为 npm 包发布,transformers.js + onnxruntime-web 的 WASM 实际数十 MB,硬依赖会拖累所有 CLI 用户与 Lite 版,违背分层定位。改为:
- 引擎代码放 `core/src/translate/`,但通过 **lazy `await import('@xenova/transformers')`**(try/catch)加载;模块不可用时返回 `ENGINE_UNAVAILABLE`,能力标记 `translate=false`(Lite 版未装引擎时即此状态,前端显示"启用翻译"引导)。
- `@xenova/transformers` 声明为 **`@doc77/electron` 的 dependency**(供 Full 版 bundle)+ **`@doc77/core` 的 devDependency**(供 dev/测试);**不进 core 的 runtime dependencies**。
- Lite 版运行时按需安装引擎(见决策 3),npm CLI 用户按文档 `pnpm add` 或复用同一按需安装通道。

### 决策 3:双版本发行(Lite / Full)—— 对齐现有 Electron 按需安装机制
现状:`electron-builder.yml` 已 `!node_modules/@doc77/mcp`、`!node_modules/@doc77/ai` 把两模块排除在包外,并由 `POST /api/electron/install`(`app.ts` 200-227 行)在运行时下载 npm tarball 安装。**Lite/Full 正是这套机制的自然延伸:**

- **Lite 版**(`electron-builder.lite.yml`,= 现有 `electron-builder.yml` 现状):排除 `@doc77/ai`、`@doc77/mcp`、`@xenova/transformers`。用户在 UI 点"启用翻译"→ 走 `/api/electron/install` 装引擎 → 再 `vendor-install` 下模型。安装包最小。
- **Full 版**(`electron-builder.full.yml`):`files` 不排除上述模块,**bundle 引擎 + ai + mcp + 默认 en-zh/zh-en 模型**,真正开箱即用离线可用。
- 扩展 `/api/electron/install` 的 `module` 白名单,新增 `'translate'`(下载并落地 `@xenova/transformers` 到 electron-modules 目录),与现有 ai/mcp 安装逻辑同构。
- CI(`.github/workflows/release-electron.yml`)矩阵增加 edition 维度(lite / full × 三平台),产物命名区分(如 `Doc77-lite-*` / `Doc77-*`)。

### 决策 4:模型下载 = 优先用 transformers.js 自带下载器 + 镜像(**修正 Plan agent**)
Plan agent 手工枚举模型文件列表。**不采纳** —— opus-mt 是 encoder-decoder,文件是带 `onnx/` 子目录的一整棵树(`onnx/encoder_model_quantized.onnx`、`onnx/decoder_model_merged_quantized.onnx`、`tokenizer.json`、`config.json`、`generation_config.json`、`source.spm`/`target.spm` 等),手工列易漏且要保留子路径。改为:
- 配置 transformers.js:`env.cacheDir = ~/.doc77/translate-models`、`env.remoteHost` 在 `translate.mirror=true` 时指向 `https://hf-mirror.com`(国内可达),`env.allowLocalModels=true`。
- `vendor-install --translate en-zh` 的实现 = **触发一次模型 warm-up 加载**,让 transformers.js 自己把整棵文件树下到 cacheDir。断网后即从本地 cache 加载。
- `vendor.ts` 的角色:提供下载目录常量 + 进度日志封装,不再手工列文件。

---

## 落地设计

### 新增文件(`packages/core/src/translate/`)
| 文件 | 职责 |
|---|---|
| `models.ts` | 模型清单:pair → HF repoId(`Xenova/opus-mt-en-zh` / `Xenova/opus-mt-zh-en`)、显示体积、镜像开关说明 |
| `engine.ts` | transformers.js 封装:lazy import、`env` 配置(cacheDir/remoteHost/mirror)、`loadModel(pair)` 内存缓存 pipeline、`translate(text, pair)` |
| `segmenter.ts` | 长文本分段:按段落(`\n\n`)→ 句末标点(`。！？.!?`)→ 超长无标点按字数,保留原始 index 供重组 |
| `index.ts` | 公共 API:`translateText(text, pair, mode)`、`isEngineAvailable()`、`isModelReady(pair)`、`downloadModel(pair, useMirror)` |
| `__tests__/segmenter.test.ts` | 分段单元测试(vitest) |
| `__tests__/engine.test.ts` | 引擎集成测试(mock `@xenova/transformers`,验证 lazy import 失败降级、模型缺失报错) |

### 修改文件
| 文件 | 改动 |
|---|---|
| `packages/core/src/server/app.ts`(路由) | 新增 `POST /api/translate`(inline 注册,参考 `/api/ai/test`)+ `GET /api/translate/status`(返回 `{engineAvailable, models:{'en-zh':bool,...}}`);扩展 `setCapabilities`/`_capabilities` 增加 `translate` |
| `packages/core/src/server/app.ts`(install 白名单) | `/api/electron/install` 的 `module` 白名单从 `['ai','mcp']` 扩到 `['ai','mcp','translate']` |
| `packages/core/src/server/vendor.ts` | 增加 translate 模型目录常量 + 下载进度封装(触发 transformers.js warm-up),不手工列文件 |
| `packages/core/src/index.ts` | 导出 translate 模块 |
| `packages/core/src/db/config.ts` | `loadDefaults()` 增加 `translate.*` 默认值 |
| `packages/core/src/web/preview.html` | 工具栏 TTS 按钮旁加 🌐 翻译按钮(默认 disabled) |
| `packages/core/src/web/js/preview.js` | `toggleTranslate()`、选区翻译浮层、整篇双栏对照、翻译缓存(`window.__translateCache`)、按 `/api/translate/status` 显隐按钮 |
| `packages/core/src/web/js/common.js` | 设置面板加"翻译"tab(启用开关、镜像开关、默认语向、模型状态/下载指引) |
| `packages/core/package.json` | `@xenova/transformers` 加入 **devDependencies**(非 runtime dep) |
| `packages/electron/package.json` | `@xenova/transformers` 加入 **dependencies**(供 Full 版 bundle);scripts 增加 `dist:lite` / `dist:full`(`electron-builder -c <config>`) |
| `packages/cli/src/bin/doc77.ts` | `vendor-install` 命令(约 657-668 行)支持 `--translate en-zh|zh-en|all` |
| `packages/electron/electron-builder.lite.yml`(新增,= 现有 `.yml`) | Lite 版:排除 `@doc77/ai`、`@doc77/mcp`、`@xenova/transformers` |
| `packages/electron/electron-builder.full.yml`(新增) | Full 版:不排除上述模块;可选预置默认模型到 `assets/models/` 并首启复制到 `~/.doc77/translate-models/` |
| `.github/workflows/release-electron.yml` | 矩阵加 edition 维度(lite/full × 三平台),产物命名区分 |

### API 设计
`POST /api/translate` — 请求 `{text, source_lang, target_lang, mode:'sentence'|'document'}`,响应 `{translated_text, segments, duration_ms, model}`。**非流式**(MT 模型需完整输入,SSE 无收益)。模型未就绪返回 `503 {error:'MODEL_NOT_READY', message:'请运行 doc77 vendor-install --translate en-zh'}`;引擎未安装返回 `{error:'ENGINE_UNAVAILABLE'}`。

`GET /api/translate/status` — 供前端决定是否显示 🌐 按钮。

### 配置项(复用 `ai.*` 的 config 表 + `PUT /api/config` 模式)
`translate.enabled`(默认 `true`)、`translate.mirror`(默认 `false`,国内用户开)、`translate.default_source`(`auto`)、`translate.default_target`(`zh`)、`translate.max_segment_length`(`500`)。均非敏感字段,不加密。

### 前端交互
- **选区翻译(主场景):** 划选文本 → 浮出"🌐 翻译" → `mode:'sentence'` → 结果 tooltip 显示在选区下方。
- **整篇翻译:** 点工具栏 🌐 → `mode:'document'` → 双栏对照(原文 | 译文),工具栏切换"原文/译文"。
- 参照现有 TTS 按钮模式(`preview.js` 约 834-849 行)与 AI 结果展示(约 1095 行)。

---

## 分阶段实施(每步可独立提交)

- **Phase A — 下载基建**:`models.ts` + `index.ts`(`downloadModel`)+ `vendor.ts` 扩展 + CLI `vendor-install --translate`。验证:`doc77 vendor-install --translate en-zh` 后 `~/.doc77/translate-models/` 出现完整模型树。
- **Phase B — 引擎**:`engine.ts`(lazy import + env 配置 + pipeline 缓存)+ `segmenter.ts`。验证:单测通过,本机能翻一句 en→zh。
- **Phase C — API**:`app.ts` 加 `/api/translate` + `/api/translate/status` + `translate` capability。验证:curl 打通,模型缺失返回清晰错误。
- **Phase D — 前端**:preview 工具栏按钮 + 选区/整篇两种交互 + 设置 tab。验证:预览页可翻译并展示。
- **Phase E — 配置默认值 + CLI 收尾**:`config.ts` 默认值,镜像开关贯通下载路径。
- **Phase F — 引擎打包(Full 版)+ 按需安装(Lite 版)**:`@doc77/electron` 加 dep;扩 `/api/electron/install` 白名单加 `translate`;`asar list | grep transformer` 确认 Full 版 WASM 进包;Lite 版点"启用翻译"能运行时装引擎。
- **Phase G — 双版本打包 + CI**:拆 `electron-builder.lite.yml` / `.full.yml`,加 `dist:lite`/`dist:full` scripts,release workflow 矩阵加 edition 维度。验证:两个变体都能出三平台包,Lite 明显更小、Full 开箱即用离线翻译。

---

## 验证方式(端到端)

1. **单测**:`pnpm test`(新增 segmenter / engine 测试)。
2. **CLI**:`doc77 vendor-install --translate en-zh` → 检查 `~/.doc77/translate-models/` 文件树完整。
3. **API**:`curl -X POST localhost:2777/api/translate -d '{"text":"Hello world","source_lang":"en","target_lang":"zh","mode":"sentence"}'` → 返回中文译文。
4. **前端**:`pnpm dev:restart` → 预览页选区翻译 + 整篇双栏对照。
5. **离线**:断网后重复步骤 3-4,仍成功(证明本机推理)。
6. **镜像**:设 `translate.mirror=true`,删除 cache 重新下载,走 hf-mirror.com。
7. **Electron 双版本**:
   - Full:`pnpm --filter @doc77/electron dist:full` → `asar list | grep transformer` 确认 WASM 已 bundle,装包后**断网**直接可翻译。
   - Lite:`dist:lite` → 包体明显更小;首次点"启用翻译"走 `/api/electron/install` 装引擎 + `vendor-install` 下模型后可翻译。
8. **提交前 CI 预检**(项目强制):`pnpm format:check && pnpm lint && pnpm build && pnpm test` 全绿。

---

## 待评审 / 待实现时确认的开放点

- **transformers.js 包名/版本**:`@xenova/transformers` v2 vs `@huggingface/transformers` v3(后者 Node 支持更好)—— 实现首步 spike 确认,并实测安装体积以最终敲定"devDep + Electron dep"的放置。
- **opus-mt-zh-en / en-zh 的实际 pipeline 行为与分词器文件树** —— 以 warm-up 下载后的真实目录为准。
- **Full 版是否预置模型**:仅 bundle 引擎(首启下模型,Full 包较小)vs bundle 引擎 + 默认 en-zh/zh-en 模型(真·断网开箱即用,+~160MB)。方案默认取后者(贴合"自带全部模块"),但体积敏感时可退回前者 —— 定稿实现前按实测包体二选一。
- **翻译质量下限**:Opus-MT int8 属"日常可用"级别,长句/专业术语弱于 LLM。需确认这一质量档位符合"可选亮点"预期。
