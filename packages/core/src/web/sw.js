/**
 * Doc77 Service Worker — PWA 离线缓存
 * 策略:
 *   App Shell (HTML/CSS/JS): Cache First + 后台更新
 *   Vendor 资产: Cache First (长期)
 *   API 文档内容: Stale While Revalidate + IndexedDB
 *   缩略图: Cache First + LRU
 *   分享页 /s/: Network First
 */
'use strict';

var CACHE_VERSION = 'doc77-v1';
var CACHE_SHELL = CACHE_VERSION + '-shell';
var CACHE_VENDOR = CACHE_VERSION + '-vendor';
var CACHE_API = CACHE_VERSION + '-api';
var CACHE_THUMBS = CACHE_VERSION + '-thumbs';

// App Shell 资源列表
var SHELL_ASSETS = [
  '/',
  '/css/app.css',
  '/css/tailwind.css',
  '/js/common.js',
  '/js/dashboard.js',
  '/js/preview.js',
  '/assets/favicon.svg',
  '/assets/logo.svg',
  '/assets/logo-dark.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json'
];

// ═══════ Install ═══════
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(function (cache) {
      return cache.addAll(SHELL_ASSETS).catch(function () {
        // 部分资源可能不存在，忽略
        return Promise.resolve();
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ═══════ Activate ═══════
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key.indexOf(CACHE_VERSION) !== 0;
        }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ═══════ Fetch ═══════
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // 分享页: Network First
  if (url.pathname.indexOf('/s/') === 0) {
    event.respondWith(networkFirst(event.request, CACHE_API));
    return;
  }

  // API 文档内容: Stale While Revalidate + IndexedDB 离线
  if (url.pathname.indexOf('/api/content/') === 0 ||
      url.pathname.indexOf('/api/tree/') === 0) {
    event.respondWith(staleWhileRevalidateAPI(event.request));
    return;
  }

  // 缩略图: Cache First + LRU
  if (url.pathname.indexOf('/api/thumbnails/') === 0 ||
      url.pathname.indexOf('/api/gallery/') === 0) {
    event.respondWith(cacheFirstLRU(event.request, CACHE_THUMBS, 200));
    return;
  }

  // Vendor 资产: Cache First (immutable)
  if (url.pathname.indexOf('/vendor/') === 0) {
    event.respondWith(cacheFirst(event.request, CACHE_VENDOR));
    return;
  }

  // 静态资源 (CSS/JS/图片/字体): Cache First + 后台更新
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirstUpdate(event.request, CACHE_SHELL));
    return;
  }

  // HTML 页面导航: Network First + 离线 fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationHandler(event.request));
    return;
  }

  // 其他: 直接 fetch
  event.respondWith(fetch(event.request));
});

// ═══════ 策略实现 ═══════

/** Cache First — 缓存优先，无缓存则 fetch */
function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, clone);
        });
      }
      return response;
    });
  });
}

/** Cache First + 后台更新 — 先返回缓存，后台静默更新 */
function cacheFirstUpdate(request, cacheName) {
  return caches.match(request).then(function (cached) {
    var fetchPromise = fetch(request).then(function (response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, clone);
        });
      }
      return response;
    }).catch(function () { return null; });

    if (cached) {
      // 有缓存: 返回缓存，后台更新
      fetchPromise; // fire and forget
      return cached;
    }
    // 无缓存: 等待网络
    return fetchPromise.then(function (r) {
      return r || new Response('Offline', { status: 503 });
    });
  });
}

/** Network First — 网络优先，失败用缓存 */
function networkFirst(request, cacheName) {
  return fetch(request).then(function (response) {
    if (response.ok) {
      var clone = response.clone();
      caches.open(cacheName).then(function (cache) {
        cache.put(request, clone);
      });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      return cached || new Response('Offline', { status: 503 });
    });
  });
}

/** Stale While Revalidate + IndexedDB 离线缓存 */
function staleWhileRevalidateAPI(request) {
  var cacheKey = request.url;

  return caches.open(CACHE_API).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var fetchPromise = fetch(request).then(function (response) {
        if (response.ok) {
          var clone = response.clone();
          cache.put(request, clone);
          // 同时存入 IndexedDB 用于深度离线
          saveToIDB(request.url, response.clone());
        }
        return response;
      }).catch(function () {
        // 网络失败，尝试 IndexedDB
        if (!cached) {
          return getFromIDB(request.url).then(function (data) {
            if (data) {
              return new Response(data.body, {
                status: 200,
                headers: {
                  'Content-Type': data.contentType || 'application/json',
                  'X-Doc77-Offline': 'true',
                  'X-Doc77-Cached-At': data.cachedAt || ''
                }
              });
            }
            return new Response(JSON.stringify({ error: 'offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          });
        }
        return null;
      });

      if (cached) {
        // 返回缓存，添加离线标记 header
        var headers = new Headers(cached.headers);
        headers.set('X-Doc77-Cache', 'hit');
        fetchPromise; // 后台更新
        return new Response(cached.body, { status: cached.status, headers: headers });
      }
      return fetchPromise;
    });
  });
}

/** Cache First + LRU 淘汰 */
function cacheFirstLRU(request, cacheName, maxEntries) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, clone);
          // LRU: 超出上限时删除最旧的
          cache.keys().then(function (keys) {
            if (keys.length > maxEntries) {
              var toDelete = keys.slice(0, keys.length - maxEntries);
              toDelete.forEach(function (key) { cache.delete(key); });
            }
          });
        });
      }
      return response;
    });
  });
}

/** 导航请求处理 — 离线时返回缓存的 shell */
function navigationHandler(request) {
  return fetch(request).then(function (response) {
    // 在线时缓存 HTML 页面
    if (response.ok) {
      var clone = response.clone();
      caches.open(CACHE_SHELL).then(function (cache) {
        cache.put(request, clone);
      });
    }
    return response;
  }).catch(function () {
    // 离线: 尝试缓存
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      // 最终 fallback: 返回 Dashboard 缓存
      return caches.match('/').then(function (shell) {
        return shell || new Response(
          '<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#0f172a;color:#e2e8f0"><div style="text-align:center"><h1>📴 Offline</h1><p>Doc77 is not reachable. Please check your connection.</p></div></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
      });
    });
  });
}

// ═══════ IndexedDB 辅助 ═══════

function openIDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('doc77-offline', 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('content')) {
        db.createObjectStore('content', { keyPath: 'url' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function saveToIDB(url, response) {
  response.text().then(function (body) {
    openIDB().then(function (db) {
      var tx = db.transaction('content', 'readwrite');
      tx.objectStore('content').put({
        url: url,
        body: body,
        contentType: response.headers.get('Content-Type') || 'application/json',
        cachedAt: new Date().toISOString()
      });
    }).catch(function () { /* IDB 不可用时静默失败 */ });
  }).catch(function () {});
}

function getFromIDB(url) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction('content', 'readonly');
      var req = tx.objectStore('content').get(url);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; });
}

// ═══════ 工具函数 ═══════

function isStaticAsset(pathname) {
  return /\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ttf|eot|ico|webp)$/.test(pathname);
}

// ═══════ Message 处理（与主线程通信） ═══════
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    // 用户请求清除离线缓存
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf(CACHE_VERSION) === 0) return caches.delete(key);
      }));
    }).then(function () {
      event.source.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
