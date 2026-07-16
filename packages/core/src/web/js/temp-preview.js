/**
 * temp-preview.js — Doc77 临时文件拖拽预览逻辑。
 *
 * 纯逻辑层（不碰 DOM）：生成临时 path 标识、文件分类、二进制嗅探。
 * preview.js 负责拖拽 UI、预填 tabDataCache、调用 openTab。
 *
 * UMD 包装：浏览器里作为全局 `window.TempPreview`；vitest 里作为 CommonJS 模块导入。
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.TempPreview = api;
})(
  typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null,
  function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════

    /** Text files larger than this (bytes) skip the POST and show a "too large" card. */
    var TEMP_TEXT_LIMIT = 4 * 1024 * 1024; // 4 MB

    /** Extensions that the frontend renders via URL.createObjectURL (no POST needed). */
    var BINARY_PREVIEW_EXTS = {
      '.png': true, '.jpg': true, '.jpeg': true, '.gif': true,
      '.svg': true, '.webp': true, '.bmp': true, '.ico': true, '.avif': true,
      '.pdf': true,
      '.docx': true, '.xlsx': true,
    };

    /** Extensions the frontend should skip entirely (unsupported). */
    var UNSUPPORTED_EXTS = {
      '.mp4': true, '.avi': true, '.mov': true, '.mkv': true, '.webm': true,
      '.wmv': true, '.flv': true, '.m4v': true,
      '.mp3': true, '.wav': true, '.ogg': true, '.flac': true, '.aac': true,
      '.wma': true, '.m4a': true, '.opus': true,
      '.zip': true, '.tar': true, '.gz': true, '.7z': true, '.rar': true,
      '.bz2': true, '.xz': true, '.zst': true,
      '.ttf': true, '.woff': true, '.woff2': true, '.otf': true, '.eot': true,
      '.exe': true, '.dll': true, '.so': true, '.dylib': true, '.bin': true,
      '.dat': true, '.class': true, '.jar': true, '.wasm': true,
      '.db': true, '.sqlite': true, '.sqlite3': true,
      '.psd': true, '.ai': true, '.sketch': true, '.fig': true, '.xd': true,
      '.epub': true, '.mobi': true,
      '.pages': true, '.numbers': true, '.key': true, '.ppt': true, '.pptx': true,
    };

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════

    /** Generate a unique temp:// path for a dropped file. */
    function makeTempPath(filename) {
      var id;
      try { id = crypto.randomUUID(); } catch (e) { id = Date.now() + '-' + Math.floor(Math.random() * 1e9); }
      return 'temp://' + id + '/' + filename;
    }

    /** Check whether a path is a temp (drag-and-drop) path. */
    function isTempPath(path) {
      return typeof path === 'string' && path.indexOf('temp://') === 0;
    }

    /** Get the file extension (lowercase) from a filename. */
    function getExt(filename) {
      var dot = filename.lastIndexOf('.');
      return dot === -1 ? '' : filename.slice(dot).toLowerCase();
    }

    /**
     * Classify a dropped file for preview.
     *
     * Returns one of:
     *   'binary-preview' — render client-side via objectURL (no POST)
     *   'text-render'    — send to POST /api/render-temp
     *   'unsupported'    — show unsupported info card
     */
    function classifyTempFile(filename) {
      var ext = getExt(filename);
      if (BINARY_PREVIEW_EXTS[ext]) return 'binary-preview';
      if (UNSUPPORTED_EXTS[ext]) return 'unsupported';
      // Everything else (md, code, mermaid, txt, etc.) -> text-render
      return 'text-render';
    }

    /**
     * Check the first 8 KB of a file for null bytes (mirrors isBinaryFile in fs/index.ts).
     * @param {File} file
     * @returns {Promise<boolean>} true if binary (contains null byte)
     */
    function sniffBinary(file) {
      return file.slice(0, 8192).arrayBuffer().then(function (buf) {
        var view = new Uint8Array(buf);
        for (var i = 0; i < view.length; i++) {
          if (view[i] === 0) return true;
        }
        return false;
      }).catch(function () {
        // On read error, assume binary for safety
        return true;
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════════

    return {
      makeTempPath: makeTempPath,
      isTempPath: isTempPath,
      classifyTempFile: classifyTempFile,
      sniffBinary: sniffBinary,
      TEMP_TEXT_LIMIT: TEMP_TEXT_LIMIT,
      BINARY_PREVIEW_EXTS: BINARY_PREVIEW_EXTS,
    };
  }
);
