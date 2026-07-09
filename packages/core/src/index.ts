/**
 * @doc77/core — Doc77 核心引擎
 *
 * 提供数据库、文件系统抽象层、预览引擎和 Express Server。
 */

export const VERSION = '0.1.0';

// Crypto
export {
  encrypt,
  decrypt,
  deriveKey,
  generateSalt,
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  isSensitiveKey,
  maskSensitive,
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
export {
  registerProject,
  listProjects,
  removeProject,
  updateProject,
} from './db/projects.js';
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

// Server
export { createApp, createQueueApproveHandler, createAIChatHandler } from './server/app.js';

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
