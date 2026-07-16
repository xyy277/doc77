/**
 * tabs.js — Doc77 multi-tab preview logic layer (tab list management + LRU eviction for rendered DOM).
 *
 * Only maintains ordering, active selection, capacity eviction, and an LRU key for
 * "rendered nodes" without touching the DOM.
 * preview.js is responsible for applying these decisions to real DOM (mounting/destroying
 * content nodes, caching data/scrollTop).
 *
 * UMD wrapper: exposed as global `window.TabStore` in the browser; imported as a CommonJS
 * module in vitest.
 */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.TabStore = api;
})(
  typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null,
  function () {
    'use strict';

    /**
     * @param {{maxTabs?: number, maxRendered?: number}} [opts]
     */
    function createTabStore(opts) {
      opts = opts || {};
      var maxTabs = opts.maxTabs || 8;
      var maxRendered = opts.maxRendered || 3;

      var tabs = []; // [{ path, title }]  — order equals tab bar display order
      var active = null; // currently active tab path
      var touch = []; // path[], most recently used at the end (for tab capacity eviction)
      var rendered = []; // path[], most recently rendered at the end (for DOM node LRU)

      function indexOf(path) {
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path === path) return i;
        return -1;
      }
      function bump(arr, path) {
        var i = arr.indexOf(path);
        if (i >= 0) arr.splice(i, 1);
        arr.push(path);
      }

      /** Open (or activate an existing) tab. Returns { evicted: string[] } (paths closed due to capacity). */
      function open(path, title) {
        var evicted = [];
        if (indexOf(path) < 0) {
          tabs.push({ path: path, title: title || path });
        } else if (title) {
          tabs[indexOf(path)].title = title;
        }
        active = path;
        bump(touch, path);

        // Over capacity: evict the least recently used non-active tab
        while (tabs.length > maxTabs) {
          var victim = null;
          for (var i = 0; i < touch.length; i++) {
            if (touch[i] !== active && indexOf(touch[i]) >= 0) {
              victim = touch[i];
              break;
            }
          }
          if (victim == null) break; // only active tab remains, stop
          removeTab(victim);
          evicted.push(victim);
        }
        return { evicted: evicted };
      }

      /** Activate an existing tab (updates active state and usage order). */
      function activate(path) {
        if (indexOf(path) < 0) return false;
        active = path;
        bump(touch, path);
        return true;
      }

      function removeTab(path) {
        var i = indexOf(path);
        if (i >= 0) tabs.splice(i, 1);
        var ti = touch.indexOf(path);
        if (ti >= 0) touch.splice(ti, 1);
        dropRendered(path);
      }

      /**
       * Close a tab. Returns { active, closed }.
       * If the active tab is closed, activates the adjacent tab (right first, otherwise left).
       */
      function close(path) {
        var i = indexOf(path);
        if (i < 0) return { active: active, closed: false };
        var wasActive = active === path;
        removeTab(path);
        if (wasActive) {
          if (tabs.length === 0) {
            active = null;
          } else {
            var next = tabs[i] || tabs[i - 1]; // current position is now the right neighbor, otherwise left
            active = next ? next.path : null;
            if (active) bump(touch, active);
          }
        }
        return { active: active, closed: true };
      }

      /** Record that a path's content has been rendered as a DOM node. Returns the path to destroy (or null) due to LRU overflow. */
      function noteRendered(path) {
        bump(rendered, path);
        if (rendered.length > maxRendered) {
          return rendered.shift();
        }
        return null;
      }

      /** Remove a path from the "rendered" set (its DOM node has been destroyed). */
      function dropRendered(path) {
        var i = rendered.indexOf(path);
        if (i >= 0) rendered.splice(i, 1);
      }

      return {
        open: open,
        activate: activate,
        close: close,
        noteRendered: noteRendered,
        dropRendered: dropRendered,
        list: function () {
          return tabs.slice();
        },
        has: function (path) {
          return indexOf(path) >= 0;
        },
        activePath: function () {
          return active;
        },
        renderedList: function () {
          return rendered.slice();
        },
      };
    }

    return { createTabStore: createTabStore };
  }
);
