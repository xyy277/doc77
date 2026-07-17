/**
 * Doc77 Mobile — Shared utilities (auth gate, theme, toast, settings, loading, i18n runtime).
 * Loaded by both mobile/index.html and mobile/preview.html.
 */

//══════════ i18n ══════════
window.__doc77_dict = {};
window.t = function (key, params) {
  var v = window.__doc77_dict[key] || key;
  return v.replace(/\{(\w+)\}/g, function (m, name) {
    return params && name in params ? String(params[name]) : m;
  });
};
window.applyI18n = function (root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
};
window.__doc77_i18n_ready = fetch('/api/i18n?' + (function () {
  var o = localStorage.getItem('doc77_lang');
  return o ? 'lang=' + encodeURIComponent(o)
           : 'hint=' + encodeURIComponent(navigator.language || '');
})()).then(function (r) { return r.json(); }).then(function (d) {
  window.__doc77_dict = d.dict;
  window.__doc77_lang = d.lang;
  window.__doc77_locales = d.available;
  window.__doc77_lang_global = d.global;
  document.documentElement.lang = d.lang;
}).catch(function () {}).then(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyI18n(); });
  } else {
    applyI18n();
  }
  document.documentElement.classList.remove('i18n-loading');
});

//══════════ Global Loading Overlay ══════════
var _loadingOverlay = null;
window.showLoading = function(msg) {
  hideLoading();
  msg = msg || t('common.loading.pleaseWait');
  var o = document.createElement('div');
  o.className = 'loading-overlay';
  o.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">' + msg + '</div>';
  document.body.appendChild(o);
  _loadingOverlay = o;
};
window.hideLoading = function() {
  if (_loadingOverlay) { _loadingOverlay.remove(); _loadingOverlay = null; }
};

//══════════ Auth Login Gate ══════════
(function () {
  if (sessionStorage.getItem('doc77-auth')) return;

  // Wait for both auth status AND i18n dict before rendering (timing safety)
  Promise.all([
    fetch('/api/auth/status').then(function (r) { return r.json(); }),
    window.__doc77_i18n_ready
  ]).then(function (results) {
    var data = results[0];
    if (!data.hasPassword) {
      showSecurityPrompt();
      return;
    }
    showLoginGate();
  }).catch(function () {});

  function showLoginGate() {
    var isDark = document.documentElement.classList.contains('dark');
    var bg       = isDark ? '#0f172a' : '#f8fafc';
    var cardBg   = isDark ? '#1e293b' : '#ffffff';
    var text     = isDark ? '#e2e8f0' : '#1e293b';
    var subtext  = isDark ? '#94a3b8' : '#64748b';
    var muted    = isDark ? '#64748b' : '#94a3b8';
    var inputBg  = isDark ? '#0f172a' : '#ffffff';
    var inputBd  = isDark ? '#334155' : '#e2e8f0';

    var o = document.createElement('div');
    o.id = 'loginGate';
    o.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;background:'+bg+';padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">' +
        '<div style="width:100%;max-width:360px;text-align:center">' +
          '<div style="font-size:64px;margin-bottom:16px">📁</div>' +
          '<h1 style="font-size:24px;font-weight:700;color:'+text+';margin:0 0 8px">Doc77</h1>' +
          '<p style="font-size:14px;color:'+subtext+';margin:0 0 28px">' + t('common.login.enterPassword') + '</p>' +
          '<input id="loginPass" type="password" placeholder="' + t('common.login.password') + '" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:14px 16px;border:1px solid '+inputBd+';border-radius:12px;font-size:16px;background:'+inputBg+';color:'+text+';outline:none;margin-bottom:16px;-webkit-appearance:none" onkeydown="if(event.key===\'Enter\')unlock()">' +
          '<button onclick="unlock()" id="loginBtn" style="width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation">' + t('common.login.unlock') + '</button>' +
          '<div id="loginError" style="color:#dc2626;font-size:13px;margin-top:12px;display:none"></div>' +
          '<p style="font-size:12px;color:'+muted+';margin-top:40px">Doc77 — ' + t('common.login.localDocManagement') + '</p>' +
        '</div>' +
      '</div>';
    o.style.cssText = 'position:fixed;inset:0;z-index:200;background:'+bg;
    document.body.appendChild(o);

    window.unlock = async function () {
      var p = document.getElementById('loginPass').value;
      var e = document.getElementById('loginError');
      var btn = document.getElementById('loginBtn');
      if (!p) { e.textContent = t('common.auth.enterPassword'); e.style.display = 'block'; return; }
      e.style.display = 'none';
      // Button loading state
      if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
      try {
        var r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: p }),
        });
        var d = await r.json();
        if (d.ok) {
          sessionStorage.setItem('doc77-auth', '1');
          // Glow ripple transition
          var card = document.querySelector('.login-gate-card') || document.querySelector('[style*="max-width:360px"]');
          if (card) {
            var rect = card.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var ripple = document.createElement('div');
            ripple.className = 'login-gate-ripple';
            ripple.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;transform:translate(-50%,-50%)';
            document.body.appendChild(ripple);
            setTimeout(function(){ if (ripple) ripple.remove(); }, 600);
          }
          var gate = document.getElementById('loginGate');
          setTimeout(function() {
            if (gate) gate.classList.add('login-gate-dissolve');
          }, 120);
          setTimeout(function() { o.remove(); }, 600);
        } else {
          e.textContent = d.error || t('common.auth.wrongPassword');
          e.style.display = 'block';
        }
      } catch(ex) {
        e.textContent = t('common.login.networkError', {message: ex.message});
        e.style.display = 'block';
      } finally {
        if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
      }
    };
  }

  async function showSecurityPrompt() {
    try {
      var sr = await fetch('/api/config');
      var sd = await sr.json();
      if ((sd['ai.token'] || sd['ai.enabled'] === 'true')) {
        var isDark = document.documentElement.classList.contains('dark');
        var sb = document.createElement('div');
        sb.id = 'securityBanner';
        sb.style.cssText =
          'position:fixed;top:0;left:0;right:0;z-index:190;' +
          'background:' + (isDark ? '#451a03' : '#fffbeb') + ';' +
          'border-bottom:1px solid ' + (isDark ? '#78350f' : '#fde68a') + ';' +
          'padding:10px 16px;font-size:12px;' +
          'color:' + (isDark ? '#fde68a' : '#92400e') + ';' +
          'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;' +
          'font-family:-apple-system,BlinkMacSystemFont,sans-serif';
        sb.innerHTML =
          '<span>⚠️ ' + t('common.login.securityBannerSimple') + '</span>' +
          '<button onclick="this.parentElement.remove();if(typeof openSettings===\'function\')openSettings(\'account\')" style="padding:6px 12px;background:#d97706;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">' + t('common.login.setPassword') + '</button>';
        document.body.insertBefore(sb, document.body.firstChild);
      }
    } catch (e) {}
  }
})();

//══════════ Toast ══════════
window.toast = function (msg, type) {
  type = type || 'info';
  var container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:300;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  var el = document.createElement('div');
  var bg = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#2563eb';
  var isDark = document.documentElement.classList.contains('dark');
  var shadow = isDark ? '0 4px 12px rgba(0,0,0,0.4)' : '0 4px 12px rgba(0,0,0,0.15)';
  el.style.cssText =
    'padding:10px 16px;border-radius:8px;font-size:13px;color:#fff;box-shadow:' + shadow + ';max-width:280px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;animation:fadeIn .3s ease-out';
  el.textContent = msg;
  el.style.background = bg;
  container.appendChild(el);
  setTimeout(function () {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(function () { el.remove(); }, 300);
  }, 2500);
};

//══════════ Theme Toggle ══════════
window.toggleTheme = function () {
  var html = document.documentElement;
  var isDark = html.classList.contains('dark');
  if (isDark) {
    html.classList.remove('dark');
    localStorage.setItem('doc77-theme', 'light');
  } else {
    html.classList.add('dark');
    localStorage.setItem('doc77-theme', 'dark');
  }
};

// Clear desktop-override cookie when mobile page loads
// (ensures explicit /mobile/ path is always a reliable escape hatch)
document.cookie = 'doc77-desktop=;path=/;max-age=0';

// Init theme
(function () {
  var saved = localStorage.getItem('doc77-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
})();

//══════════ Language Settings (for mobile settings page) ══════════
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function langSelect(id, defaultLabelKey) {
  var opts = '<option value="">' + t(defaultLabelKey) + '</option>';
  (window.__doc77_locales || []).forEach(function (l) {
    opts += '<option value="' + escapeHtml(l.code) + '">' + escapeHtml(l.name) + '</option>';
  });
  return '<select id="' + id + '" onchange="onLangChange(this)" style="font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--border-light);background:var(--bg-card);color:var(--text-primary);max-width:200px">' + opts + '</select>';
}
function onLangChange(sel) {
  if (sel.id === 'uiLangSelect') {
    if (sel.value) localStorage.setItem('doc77_lang', sel.value);
    else localStorage.removeItem('doc77_lang');
    location.reload();
  } else {
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'locale.language', value: sel.value }),
    }).then(function () { toast(t('common.settings.globalLangSaved')); })
      .catch(function(){ toast(t('common.settings.globalLangSaveFailed')); });
  }
}
