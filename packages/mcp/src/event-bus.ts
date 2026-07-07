import { EventEmitter } from 'node:events';

/**
 * Internal Event Bus — shared EventEmitter for cross-package communication.
 *
 * Events:
 * - task:queued    → { task_id, project_id, session_id, operation_type }
 * - task:executing → { task_id, project_id }
 * - task:executed  → { task_id, project_id, result }
 * - task:failed    → { task_id, project_id, error_message, rolled_back }
 * - task:approved  → { task_id, approved_by }
 * - task:rejected  → { task_id, rejected_by }
 */

let _eventBus: EventEmitter | null = null;

/**
 * Get or create the shared EventBus instance.
 */
export function getEventBus(): EventEmitter {
  if (!_eventBus) {
    _eventBus = new EventEmitter();
    _eventBus.setMaxListeners(100);
  }
  return _eventBus;
}

/**
 * Reset the event bus (for testing).
 */
export function resetEventBus(): void {
  if (_eventBus) {
    _eventBus.removeAllListeners();
  }
  _eventBus = null;
}
