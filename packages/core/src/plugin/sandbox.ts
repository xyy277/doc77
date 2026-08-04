/**
 * T11: 插件沙箱 — 使用 Node.js vm 模块隔离插件代码执行。
 *
 * 安全说明：
 * - vm 模块不是真正的安全沙箱（有逃逸风险），但对本地单用户工具可接受
 * - 提供受限 API：fs（仅限项目目录）、log
 * - 超时限制（默认 5s）
 * - 不提供 require/import，防止插件加载任意模块
 *
 * 使用方式：
 *   const sandbox = new PluginSandbox({ projectPath: '/path/to/project', timeout: 5000 });
 *   const result = sandbox.run(pluginCode, { input: 'data' });
 */
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SandboxConfig {
  /** 允许插件访问的根目录（项目路径） */
  projectPath: string;
  /** 执行超时（毫秒，默认 5000） */
  timeout?: number;
}

export interface SandboxContext {
  /** 传给插件的输入数据 */
  [key: string]: unknown;
}

export interface SandboxResult {
  /** 插件返回的结果 */
  result: unknown;
  /** 执行是否成功 */
  ok: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 插件沙箱 — 隔离执行插件代码。
 *
 * 受限 API：
 * - fs.readFile(relativePath): string — 仅允许读取 projectPath 内的文件
 * - fs.writeFile(relativePath, content): void — 仅允许写入 projectPath 内的文件
 * - log(...args): void — 输出到 console.log
 * - input: unknown — 调用方传入的数据
 */
export class PluginSandbox {
  private readonly projectPath: string;
  private readonly timeout: number;

  constructor(config: SandboxConfig) {
    this.projectPath = path.resolve(config.projectPath);
    this.timeout = config.timeout ?? 5000;
  }

  /**
   * 在沙箱中执行插件代码。
   *
   * @param code 插件源码（JavaScript）
   * @param context 传给插件的上下文数据
   * @returns 执行结果
   */
  run(code: string, context: SandboxContext = {}): SandboxResult {
    // 构建受限 API
    const safeFs = {
      readFile: (relPath: string): string => {
        const abs = this.resolveSafe(relPath);
        if (!abs) throw new Error(`Access denied: ${relPath} is outside project directory`);
        return fs.readFileSync(abs, 'utf-8');
      },
      writeFile: (relPath: string, content: string): void => {
        const abs = this.resolveSafe(relPath);
        if (!abs) throw new Error(`Access denied: ${relPath} is outside project directory`);
        fs.writeFileSync(abs, content);
      },
    };

    const sandbox = {
      fs: safeFs,
      log: (...args: unknown[]) => console.log('[plugin]', ...args),
      input: context.input,
      module: { exports: {} as Record<string, unknown> },
      exports: {} as Record<string, unknown>,
      console: { log: (...args: unknown[]) => console.log('[plugin]', ...args) },
    };

    try {
      const script = new vm.Script(`
        (function(module, exports) {
          ${code}
        })(module, exports);
      `);
      const contextObj = vm.createContext(sandbox);
      script.runInContext(contextObj, { timeout: this.timeout });

      // 插件通过 module.exports 或 exports 暴露功能
      const exported = sandbox.module.exports || sandbox.exports;
      return { result: exported, ok: true };
    } catch (e: unknown) {
      return {
        result: null,
        ok: false,
        error: e instanceof Error ? e.message : 'Sandbox execution failed',
      };
    }
  }

  /**
   * 解析相对路径为安全绝对路径（防止路径穿越）。
   * 返回 null 表示路径不安全（超出 projectPath）。
   */
  private resolveSafe(relPath: string): string | null {
    const abs = path.resolve(this.projectPath, relPath);
    // 确保解析后的路径在 projectPath 内
    if (!abs.startsWith(this.projectPath + path.sep) && abs !== this.projectPath) {
      return null;
    }
    return abs;
  }

  /**
   * 检查路径是否在项目目录内（供测试用）。
   */
  isPathSafe(relPath: string): boolean {
    return this.resolveSafe(relPath) !== null;
  }
}
