import { getConnection } from '@doc77/core';

/**
 * Result of a file size check against the configured threshold.
 */
export interface FileSizeCheck {
  overThreshold: boolean;
  needsConfirmation: boolean;
  fileSizeBytes: number;
  thresholdMB: number;
}

/**
 * Check if a file size exceeds the configured threshold.
 * @param fileSizeBytes - Size of the file in bytes
 * @param thresholdMB - Threshold in MB (default 50)
 */
export function checkFileSize(fileSizeBytes: number, thresholdMB: number = 50): FileSizeCheck {
  const thresholdBytes = thresholdMB * 1024 * 1024;
  const overThreshold = fileSizeBytes > thresholdBytes;

  return {
    overThreshold,
    needsConfirmation: overThreshold,
    fileSizeBytes,
    thresholdMB,
  };
}

/**
 * Audit log entry.
 */
export interface AuditEntry {
  project_id: number;
  operation_type: string;
  operation_data: Record<string, unknown>;
  source: 'ai' | 'user' | 'auto';
  approved_by?: string;
  status: string;
  error_message?: string;
}

/**
 * Write an audit log entry to the database.
 */
export function writeAuditLog(entry: AuditEntry): void {
  const db = getConnection();
  db.prepare(
    `INSERT INTO audit_log (project_id, operation_type, operation_data, source, approved_by, status, error_message, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    entry.project_id,
    entry.operation_type,
    JSON.stringify(entry.operation_data),
    entry.source,
    entry.approved_by || null,
    entry.status,
    entry.error_message || null,
  );
}
