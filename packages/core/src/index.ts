/**
 * @doc77/core — Doc77 核心引擎
 *
 * 提供数据库、文件系统抽象层、预览引擎和 Express Server。
 */

export { VERSION } from './version.gen.js';

// Crypto
export {
  encrypt,
  decrypt,
  deriveKey,
  generateSalt,
  hashPassword,
  verifyPassword,
  verifyPasswordLegacy,
  LEGACY_SCRYPT_OPTIONS,
  checkPasswordStrength,
  isSensitiveKey,
  maskSensitive,
  scryptSync,
  extractSalt,
  derivePasswordWrapKey,
  SCRYPT_OPTIONS,
} from './crypto.js';
export type { EncryptedData } from './crypto.js';

// Database
export {
  initDatabase,
  getConnection,
  closeConnection,
  DatabaseCompat,
  StatementCompat,
} from './db/connection.js';
export { runMigrations } from './db/migrations.js';
export { getConfig, setConfig, listConfig, loadDefaults } from './db/config.js';
export { registerProject, listProjects, removeProject, updateProject } from './db/projects.js';
export type { Project, ProjectUpdate } from './db/projects.js';

// File System
export {
  readFile,
  readFileRaw,
  isBinaryFile,
  readFirstNLines,
  statFile,
  listDir,
  isSensitiveFile,
  validatePath,
  resolveProjectPath,
} from './fs/index.js';
export type { DirEntry } from './fs/index.js';

// Scanner
export { scanDirectory, clearCache } from './scanner/index.js';
export type { ScanResult } from './scanner/index.js';
export { discoverProjects } from './scanner/discover.js';
export type { DiscoverResult } from './scanner/discover.js';

// Server
export {
  createApp,
  createQueueApproveHandler,
  createAIChatHandler,
  setCapabilities,
} from './server/app.js';
export { executeAiWriteTool, isAiWriteTool } from './server/ai-tools.js';
export type { AiWriteFns, AiWriteDeps, AiWriteCtx } from './server/ai-tools.js';

// Auth
export {
  isLegacyMode,
  setupPasswordWithDEK,
  setupPasswordLegacy,
  verifyLogin,
  verifyRecoveryCode,
  resetPasswordWithToken,
  changePassword,
  getRecoveryStatus,
  regenerateRecoveryCodes,
  forceResetPassword,
} from './server/auth.js';

// Vendor
export { fetchVendorAssets, isVendorReady, VENDOR_ASSETS } from './server/vendor.js';
export type { VendorAsset } from './server/vendor.js';

// Renderers
export {
  renderMarkdown,
  renderMermaid,
  renderPdf,
  renderImage,
  renderCode,
  getRendererForFile,
  isUnsupportedFormat,
  UNSUPPORTED_EXTENSIONS,
  FORMAT_SIZE_LIMITS,
} from './renderers/index.js';
