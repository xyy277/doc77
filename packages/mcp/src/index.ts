/**
 * @doc77/mcp — Doc77 MCP 服务层
 *
 * 提供 MCP 协议实现、安全校验、操作队列和事务系统。
 */

export { VERSION } from './version.gen.js';

// MCP Server
export { createMcpServer } from './server.js';

// Transport
export { connectStdio } from './transport/index.js';

// Tools
export { listFiles, readFileContent, readFiles, getFileInfo, getFileInfos } from './tools/readonly.js';
export type { ReadFilesResult } from './tools/readonly.js';
export { listProjects } from './tools/discovery.js';
export { searchFiles } from './tools/search.js';
export { diffFiles } from './tools/diff.js';
export {
  writeFile,
  createFolder,
  moveFile,
  deleteFile,
  batchOperations,
  getTaskStatus,
} from './tools/write.js';
export type { WriteTask } from './tools/write.js';

// Security
export { checkPathAccess, checkSensitiveFile, checkDepthLimit } from './security/guard.js';
export type { SecurityCheck } from './security/guard.js';

// Session
export {
  createSession,
  validateSession,
  touchSession,
  checkReadRateLimit,
  checkWriteRateLimit,
  cleanupExpiredSessions,
} from './session.js';
export type { Session, SessionValidation, RateLimitResult } from './session.js';

// Queue
export {
  enqueueOperation,
  getPendingTasks,
  getTaskById,
  updateTaskStatus,
  rejectExpiredTasks,
} from './queue/index.js';
export type { QueuedTask } from './queue/index.js';

// Transaction
export { runPreflightCheck } from './transaction/preflight.js';
export { safeMove } from './transaction/safeMove.js';
export { acquireProjectLock, releaseProjectLock, getActiveLock } from './transaction/lock.js';
export { performShadowBackup, rollbackFromShadow } from './transaction/shadow.js';
export { runShadowGC } from './transaction/shadowGC.js';
export { checkFileSize, writeAuditLog } from './transaction/audit.js';
export { executeApprovedTasks } from './transaction/executor.js';
export { getEventBus, resetEventBus } from './event-bus.js';
export type { PreflightResult } from './transaction/preflight.js';
export type { UndoLog, UndoLogEntry } from './transaction/shadow.js';
export type { FileSizeCheck, AuditEntry } from './transaction/audit.js';
