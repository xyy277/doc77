import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { t } from '@doc77/core';

/** Session-level agent configuration. */
export interface SessionConfig {
  mode: 'manual' | 'auto';
  risk_level: 'low' | 'medium' | 'high';
  /** If set, write ops within scope are auto-approved until expiry. */
  authorization?: {
    scope: 'all' | 'write' | 'delete';
    granted_at: number;
    duration_minutes: number; // 0 = session
  };
}

const configStore = new Map<string, SessionConfig>();

export function getSessionConfig(sessionId: string): SessionConfig {
  if (!configStore.has(sessionId)) {
    configStore.set(sessionId, { mode: 'manual', risk_level: 'medium' });
  }
  return configStore.get(sessionId)!;
}

export function setSessionConfig(sessionId: string, config: SessionConfig): void {
  configStore.set(sessionId, config);
}

export function resetSessionStore(): void {
  configStore.clear();
}

/**
 * Runtime agent configuration tool — switch between manual/auto and set risk level.
 * Config is scoped to the current session and does not affect global defaults.
 */
export function configureAgent(
  sessionId: string,
  opts: { mode?: 'manual' | 'auto'; risk_level?: 'low' | 'medium' | 'high' },
): { success: boolean; config: SessionConfig } {
  const config = getSessionConfig(sessionId);
  if (opts.mode) config.mode = opts.mode;
  if (opts.risk_level) config.risk_level = opts.risk_level;
  setSessionConfig(sessionId, config);
  return { success: true, config };
}

/**
 * Session-level authorization — grant or revoke auto-approval for a scope.
 * When authorized, write ops within scope skip the approval queue.
 */
export function sessionAuthorize(
  sessionId: string,
  action: 'grant' | 'revoke',
  scope: 'all' | 'write' | 'delete',
  duration: 'session' | '30m' | '4h',
): { success: boolean; config: SessionConfig } {
  const config = getSessionConfig(sessionId);

  if (action === 'revoke') {
    delete config.authorization;
  } else {
    const durationMinutes = duration === '30m' ? 30 : duration === '4h' ? 240 : 0;
    config.authorization = { scope, granted_at: Date.now(), duration_minutes: durationMinutes };
  }

  setSessionConfig(sessionId, config);
  return { success: true, config };
}

/**
 * Check whether a session has an active authorization for the given scope.
 */
export function isSessionAuthorized(sessionId: string, scope: string): boolean {
  const config = getSessionConfig(sessionId);
  if (!config.authorization) return false;

  // Expiry check for time-limited grants
  if (config.authorization.duration_minutes > 0) {
    const elapsed = (Date.now() - config.authorization.granted_at) / 60000;
    if (elapsed > config.authorization.duration_minutes) {
      delete config.authorization;
      return false;
    }
  }

  if (config.authorization.scope === 'all') return true;
  if (config.authorization.scope === 'write' && scope !== 'delete_file') return true;
  if (config.authorization.scope === scope) return true;
  return false;
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'configure_agent',
    {
      description: t('mcp.tool.configureAgent.desc'),
      inputSchema: {
        session_id: z.string().describe(t('mcp.param.sessionId')),
        mode: z.enum(['manual', 'auto']).optional().describe('Operation mode: manual or auto'),
        risk_level: z.enum(['low', 'medium', 'high']).optional().describe('Risk level'),
      },
    },
    async (args) => {
      const result = configureAgent(args.session_id as string, {
        mode: args.mode as 'manual' | 'auto' | undefined,
        risk_level: args.risk_level as 'low' | 'medium' | 'high' | undefined,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'session_authorize',
    {
      description: t('mcp.tool.sessionAuthorize.desc'),
      inputSchema: {
        session_id: z.string().describe(t('mcp.param.sessionId')),
        action: z.enum(['grant', 'revoke']).describe('Grant or revoke authorization'),
        scope: z.enum(['all', 'write', 'delete']).describe('Scope of authorization'),
        duration: z.enum(['session', '30m', '4h']).describe('Duration of authorization'),
      },
    },
    async (args) => {
      const result = sessionAuthorize(
        args.session_id as string,
        args.action as 'grant' | 'revoke',
        args.scope as 'all' | 'write' | 'delete',
        args.duration as 'session' | '30m' | '4h',
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
