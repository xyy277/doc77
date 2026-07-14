/**
 * Doc77 Mobile — Shared utilities (auth gate, theme, toast, settings, loading).
 * Loaded by both mobile/index.html and mobile/preview.html.
 */

//══════════ Global Loading Overlay ══════════
var _loadingOverlay = null;
window.showLoading = function(msg) {
  hideLoading();
  msg = msg || '请稍候...';
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

  fetch('/api/auth/status')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.hasPassword) {
        showSecurityPrompt();
        return;
      }
      showLoginGate();
    })
    .catch(function () {});

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
          '<p style="font-size:14px;color:'+subtext+';margin:0 0 28px">请输入密码解锁</p>' +
          '<input id="loginPass" type="password" placeholder="密码" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:14px 16px;border:1px solid '+inputBd+';border-radius:12px;font-size:16px;background:'+inputBg+';color:'+text+';outline:none;margin-bottom:16px;-webkit-appearance:none" onkeydown="if(event.key===\'Enter\')unlock()">' +
          '<button onclick="unlock()" id="loginBtn" style="width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation">解锁</button>' +
          '<div id="loginError" style="color:#dc2626;font-size:13px;margin-top:12px;display:none"></div>' +
          '<p style="font-size:12px;color:'+muted+';margin-top:40px">Doc77 — 本地文档管理</p>' +
        '</div>' +
      '</div>';
    o.style.cssText = 'position:fixed;inset:0;z-index:200;background:'+bg;
    document.body.appendChild(o);

    window.unlock = async function () {
      var p = document.getElementById('loginPass').value;
      var e = document.getElementById('loginError');
      var btn = document.getElementById('loginBtn');
      if (!p) { e.textContent = '请输入密码'; e.style.display = 'block'; return; }
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
          e.textContent = d.error || '密码错误';
          e.style.display = 'block';
        }
      } catch(ex) {
        e.textContent = '网络错误: ' + ex.message;
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
          '<span>⚠️ 已配置 AI 但未设置密码</span>' +
          '<button onclick="this.parentElement.remove();if(typeof openSettings===\'function\')openSettings(\'account\')" style="padding:6px 12px;background:#d97706;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">设置密码</button>';
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
