/**
 * Git sync adapter — uses simple-git for Git operations.
 */
import simpleGit, { type SimpleGit } from 'simple-git';
import type {
  SyncAdapter,
  AdapterConfig,
  GitAdapterConfig,
  ConnectionResult,
  SyncContext,
  PullResult,
  PushResult,
  RemoteFileEntry,
} from '../types.js';

export class GitAdapter implements SyncAdapter {
  readonly name = 'git';
  readonly displayName = 'Git Repository';

  private getGit(projectPath: string, _config: GitAdapterConfig): SimpleGit {
    const git = simpleGit(projectPath);
    return git;
  }

  async testConnection(config: AdapterConfig): Promise<ConnectionResult> {
    const cfg = config as GitAdapterConfig;
    try {
      // Try ls-remote to test connectivity
      const git = simpleGit();
      const result = await git.listRemote(['--heads', cfg.remoteUrl]);
      if (result) {
        return { ok: true, message: 'Connected successfully', server: cfg.remoteUrl };
      }
      return { ok: false, message: 'No refs found' };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      return { ok: false, message: msg };
    }
  }

  async pull(ctx: SyncContext): Promise<PullResult> {
    // 兼容读取 adapterConfig（统一字段）或 gitConfig（旧字段）
    const cfg = ctx.options as unknown as {
      adapterConfig?: GitAdapterConfig;
      gitConfig?: GitAdapterConfig;
    };
    const gitConfig = (cfg.adapterConfig || cfg.gitConfig || {}) as GitAdapterConfig;
    const git = this.getGit(ctx.projectPath, gitConfig);
    const result: PullResult = { filesUpdated: 0, filesDeleted: 0, errors: [] };

    try {
      // Ensure we're on the right branch
      const branch = gitConfig.branch || 'main';
      const remote = gitConfig.remoteName || 'origin';

      // Check if git repo exists
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        result.errors.push('Not a git repository');
        return result;
      }

      // Fetch
      await git.fetch(remote, branch);

      // Get current status before pull
      const statusBefore = await git.status();

      // Pull with strategy
      const strategy = gitConfig.pullStrategy || 'merge';
      if (strategy === 'rebase') {
        await git.pull(remote, branch, { '--rebase': null });
      } else {
        await git.pull(remote, branch);
      }

      // Count changes
      const diff = await git.diff(['--name-status', 'HEAD@{1}', 'HEAD']);
      const lines = diff.split('\n').filter(Boolean);
      for (const line of lines) {
        const [status] = line.split('\t');
        if (status.startsWith('D')) result.filesDeleted++;
        else result.filesUpdated++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Pull failed';
      // Check for merge conflicts
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        result.errors.push('Merge conflict detected: ' + msg);
      } else {
        result.errors.push(msg);
      }
    }

    return result;
  }

  async push(ctx: SyncContext): Promise<PushResult> {
    // 兼容读取 adapterConfig（统一字段）或 gitConfig（旧字段）
    const cfg = ctx.options as unknown as {
      adapterConfig?: GitAdapterConfig;
      gitConfig?: GitAdapterConfig;
    };
    const gitConfig = (cfg.adapterConfig || cfg.gitConfig || {}) as GitAdapterConfig;
    const git = this.getGit(ctx.projectPath, gitConfig);
    const result: PushResult = { filesPushed: 0, errors: [] };

    try {
      const branch = gitConfig.branch || 'main';
      const remote = gitConfig.remoteName || 'origin';
      const prefix = gitConfig.commitPrefix || '[doc77-sync]';

      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        result.errors.push('Not a git repository');
        return result;
      }

      // Stage changed files
      const status = await git.status();
      const allChanges = [
        ...status.modified,
        ...status.not_added,
        ...status.created,
        ...status.deleted,
      ];

      if (allChanges.length === 0) {
        return result; // Nothing to push
      }

      // Add all changes
      await git.add(allChanges);

      // Commit
      const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const commitMsg = `${prefix} Update ${allChanges.length} file(s) (${now})`;
      const commitResult = await git.commit(commitMsg);
      result.commitHash = commitResult.commit;
      result.filesPushed = allChanges.length;

      // Push
      await git.push(remote, branch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Push failed';
      // If push rejected (non-fast-forward), try pull --rebase then push again
      if (msg.includes('rejected') || msg.includes('non-fast-forward')) {
        try {
          const git2 = this.getGit(ctx.projectPath, gitConfig);
          await git2.pull('origin', gitConfig.branch || 'main', { '--rebase': null });
          await git2.push(gitConfig.remoteName || 'origin', gitConfig.branch || 'main');
        } catch (e2: unknown) {
          result.errors.push('Push failed after rebase: ' + (e2 instanceof Error ? e2.message : 'unknown'));
        }
      } else {
        result.errors.push(msg);
      }
    }

    return result;
  }

  async listRemote(config: AdapterConfig): Promise<RemoteFileEntry[]> {
    const cfg = config as GitAdapterConfig;
    // For Git, we use git ls-tree to list remote files
    // This requires the remote to be fetched first
    try {
      const git = simpleGit();

      // ls-remote to check availability
      await git.listRemote(['--heads', cfg.remoteUrl]);

      // Note: Full file listing requires a local clone with fetch
      // This is handled by the engine during sync
      return [];
    } catch {
      return [];
    }
  }
}

