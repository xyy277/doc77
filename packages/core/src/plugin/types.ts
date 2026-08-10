/**
 * Plugin system — type definitions.
 */

export type PluginType = 'renderer' | 'adapter' | 'theme' | 'tool' | 'widget';

export type PluginPermission =
  'read-files' | 'write-files' | 'network' | 'ai' | 'clipboard' | 'notifications';

export interface PluginManifest {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author?: string;
  type: PluginType;
  entry: string;
  doc77: {
    minVersion: string;
    permissions: PluginPermission[];
  };
  renderer?: {
    extensions: string[];
    mimeTypes?: string[];
    priority?: number;
  };
  theme?: {
    darkMode: boolean;
    preview?: string;
  };
}

export interface RenderOptions {
  filePath: string;
  projectPath: string;
  darkMode: boolean;
}

export interface RenderResult {
  html: string;
  scripts?: string[];
  styles?: string[];
}

export interface RendererPlugin {
  canRender(filePath: string, mimeType: string): boolean;
  render(content: string | Buffer, options: RenderOptions): Promise<RenderResult>;
  clientScript?(): string;
  clientStyle?(): string;
}

export interface ThemePlugin {
  readonly name: string;
  readonly displayName: string;
  css: string;
  darkMode: boolean;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  loaded: boolean;
  enabled: boolean;
  instance?: unknown;
}
