/**
 * Plugin loader — discovers, loads, and manages plugins from ~/.doc77/plugins/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { PluginManifest, LoadedPlugin, RendererPlugin, ThemePlugin } from './types.js';

const PLUGIN_DIR = path.join(os.homedir(), '.doc77', 'plugins');

export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();

  /**
   * Discover all plugins in ~/.doc77/plugins/
   */
  async discover(): Promise<void> {
    this.plugins.clear();
    if (!fs.existsSync(PLUGIN_DIR)) return;

    const dirs = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const manifestPath = path.join(PLUGIN_DIR, dir.name, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest: PluginManifest = JSON.parse(raw);
        if (!manifest.name || !manifest.type || !manifest.entry) continue;

        this.plugins.set(manifest.name, {
          manifest,
          dir: path.join(PLUGIN_DIR, dir.name),
          loaded: false,
          enabled: true,
        });
      } catch {
        // Invalid manifest, skip
      }
    }
  }

  /**
   * Load a plugin's entry module.
   */
  async loadPlugin(name: string): Promise<unknown | null> {
    const plugin = this.plugins.get(name);
    if (!plugin || !plugin.enabled) return null;
    if (plugin.loaded) return plugin.instance;

    try {
      const entryPath = path.join(plugin.dir, plugin.manifest.entry);
      const module = await import(pathToFileURL(entryPath).href);
      plugin.instance = module.default || module;
      plugin.loaded = true;
      return plugin.instance;
    } catch (e) {
      console.error(`[plugin] Failed to load ${name}:`, e);
      return null;
    }
  }

  /**
   * Get all discovered plugins.
   */
  list(): Array<{ name: string; displayName: string; type: string; version: string; enabled: boolean; loaded: boolean }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      displayName: p.manifest.displayName,
      type: p.manifest.type,
      version: p.manifest.version,
      enabled: p.enabled,
      loaded: p.loaded,
    }));
  }

  /**
   * Enable/disable a plugin.
   */
  toggle(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }

  /**
   * Get all active renderer plugins.
   */
  async getRenderers(): Promise<Array<{ plugin: RendererPlugin; extensions: string[]; priority: number }>> {
    const renderers: Array<{ plugin: RendererPlugin; extensions: string[]; priority: number }> = [];
    for (const [name, p] of this.plugins) {
      if (p.manifest.type !== 'renderer' || !p.enabled) continue;
      const instance = await this.loadPlugin(name);
      if (instance && typeof (instance as RendererPlugin).canRender === 'function') {
        renderers.push({
          plugin: instance as RendererPlugin,
          extensions: p.manifest.renderer?.extensions || [],
          priority: p.manifest.renderer?.priority || 0,
        });
      }
    }
    return renderers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all active theme plugins.
   */
  async getThemes(): Promise<ThemePlugin[]> {
    const themes: ThemePlugin[] = [];
    for (const [name, p] of this.plugins) {
      if (p.manifest.type !== 'theme' || !p.enabled) continue;
      const instance = await this.loadPlugin(name);
      if (instance) themes.push(instance as ThemePlugin);
    }
    return themes;
  }

  /**
   * Find a renderer for a file extension.
   */
  async findRenderer(ext: string): Promise<RendererPlugin | null> {
    const renderers = await this.getRenderers();
    for (const r of renderers) {
      if (r.extensions.includes(ext)) return r.plugin;
    }
    return null;
  }
}

let _loader: PluginLoader | null = null;
export function getPluginLoader(): PluginLoader {
  if (!_loader) {
    _loader = new PluginLoader();
    _loader.discover().catch(() => {});
  }
  return _loader;
}
