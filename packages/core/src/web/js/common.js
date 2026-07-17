/**
 * Doc77 Common JS — 被 index.html 和 preview.html 共享
 * 包含: Theme, Toast/Confirm, Settings, Login Gate, Helpers, i18n Runtime
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

// Module capabilities
window.__doc77_caps_ai = false;
window.__doc77_caps_mcp = false;
window.__doc77_caps_translate = false;
fetch('/api/capabilities').then(function(r){ return r.json(); }).then(function(c){
  window.__doc77_caps_ai = c.ai;
  window.__doc77_caps_mcp = c.mcp;
  window.__doc77_caps_translate = c.translate;
}).catch(function(){});

// Version badge
(function loadVersion() {
  var badge = document.getElementById('versionBadge');
  if (!badge) return;
  fetch('/api/server-info').then(function(r){ return r.json(); }).then(function(d){
    badge.textContent = 'v' + d.version;
    badge.title = 'Doc77 v' + d.version + ' — ' + d.nodeVersion + ' / ' + d.platform;
    badge.classList.add('loaded');
  }).catch(function(){
    badge.textContent = '--';
    window.__doc77_i18n_ready.then(function(){ badge.title = t('common.versionBadge.failed'); });
  });
})();

//══════════ Theme ══════════
(function initTheme() {
  const saved = localStorage.getItem('doc77-theme');
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (!saved && prefers);
  document.documentElement.classList.toggle('dark', isDark);
})();
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('doc77-theme', isDark ? 'dark' : 'light');
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

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

//══════════ Progress Overlay (Multi-step) ══════════
window.showProgressOverlay = function(title, steps) {
  hideLoading();
  // Remove existing progress overlay
  var existing = document.getElementById('progressOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'progressOverlay';
  overlay.className = 'progress-overlay';

  var stepsHtml = steps.map(function(s, i) {
    var icon = s.icon || '○';
    return '<div class="progress-step" data-step="' + i + '"><span class="step-icon">' + icon + '</span><span class="step-label">' + s.label + '</span></div>';
  }).join('');

  overlay.innerHTML = '<div class="progress-card">' +
    '<div class="progress-title">' + title + '</div>' +
    '<div class="progress-steps">' + stepsHtml + '</div>' +
    '<div class="progress-bar-track"><div class="progress-bar-fill" id="progressBarFill" style="width:0%"></div></div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Activate first step after mount
  setTimeout(function() {
    var first = overlay.querySelector('.progress-step');
    if (first) first.classList.add('active');
  }, 100);

  return {
    advance: function(stepIndex) {
      var all = overlay.querySelectorAll('.progress-step');
      for (var i = 0; i < all.length; i++) {
        all[i].classList.remove('active');
        if (i < stepIndex) all[i].classList.add('completed');
      }
      if (all[stepIndex]) all[stepIndex].classList.add('active');
      // Update progress bar
      var fill = document.getElementById('progressBarFill');
      if (fill) fill.style.width = Math.min(100, Math.round((stepIndex / (all.length - 1)) * 100)) + '%';
    },
    complete: function(callback) {
      var all = overlay.querySelectorAll('.progress-step');
      for (var i = 0; i < all.length; i++) {
        all[i].classList.remove('active');
        all[i].classList.add('completed');
      }
      var fill = document.getElementById('progressBarFill');
      if (fill) fill.style.width = '100%';
      // Delay then remove + callback
      setTimeout(function() {
        overlay.remove();
        if (callback) callback();
      }, 600);
    },
    error: function(msg) {
      overlay.innerHTML = '<div class="progress-card" style="text-align:center">' +
        '<div style="font-size:40px;margin-bottom:12px;color:var(--danger)">✕</div>' +
        '<div class="progress-title" style="color:var(--danger)">' + t('common.progress.failed') + '</div>' +
        '<p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px 0">' + msg + '</p>' +
        '<button onclick="this.closest(\'.progress-overlay\').remove()" class="btn" style="width:100%">' + t('common.progress.close') + '</button></div>';
    }
  };
};

//══════════ Toast & Confirm ══════════
(function(){
  var tc = document.createElement('div'); tc.className = 'toast-container'; document.body.appendChild(tc);
  window.toast = function(msg, type) {
    type = type || 'info';
    var t = document.createElement('div'); t.className = 'toast toast-' + type; t.textContent = msg;
    tc.appendChild(t);
    setTimeout(function(){ t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function(){ t.remove(); }, 300); }, 2500);
  };
  window.confirmDialog = function(msg) {
    return new Promise(function(resolve) {
      var o = document.createElement('div'); o.className = 'confirm-overlay';
      o.innerHTML = '<div class="confirm-box"><p style="font-size:13px;margin-bottom:16px;color:var(--text-primary)">' + msg + '</p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn cancel-btn" style="font-size:12px">' + t('common.confirm.cancel') + '</button>' +
        '<button class="btn btn-primary ok-btn" style="font-size:12px">' + t('common.confirm.ok') + '</button></div></div>';
      document.body.appendChild(o);
      o.querySelector('.ok-btn').onclick = function(){ o.remove(); resolve(true); };
      o.querySelector('.cancel-btn').onclick = function(){ o.remove(); resolve(false); };
      o.addEventListener('click', function(e){ if (e.target === o) { o.remove(); resolve(false); } });
    });
  };
  // In-app prompt dialog (replaces browser-native prompt()). Resolves to input value, or null if cancelled.
  window.promptDialog = function(opts) {
    opts = opts || {};
    var title = opts.title || '';
    var msg = opts.message || '';
    var type = opts.type || 'text';
    var placeholder = opts.placeholder || '';
    var okText = opts.okText || t('common.confirm.ok');
    var cancelText = opts.cancelText || t('common.confirm.cancel');
    return new Promise(function(resolve) {
      var o = document.createElement('div'); o.className = 'confirm-overlay';
      o.innerHTML = '<div class="confirm-box">' +
        (title ? '<div style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text-primary)">' + esc(title) + '</div>' : '') +
        (msg ? '<p style="font-size:13px;margin-bottom:12px;color:var(--text-secondary)">' + esc(msg) + '</p>' : '') +
        '<input class="input prompt-input" type="' + type + '" placeholder="' + escAttr(placeholder) + '" style="width:100%;padding:8px 12px;margin-bottom:16px">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn cancel-btn" style="font-size:12px">' + esc(cancelText) + '</button>' +
        '<button class="btn btn-primary ok-btn" style="font-size:12px">' + esc(okText) + '</button></div></div>';
      document.body.appendChild(o);
      var input = o.querySelector('.prompt-input');
      var done = function(val){ o.remove(); resolve(val); };
      o.querySelector('.ok-btn').onclick = function(){ done(input.value); };
      o.querySelector('.cancel-btn').onclick = function(){ done(null); };
      o.addEventListener('click', function(e){ if (e.target === o) done(null); });
      input.addEventListener('keydown', function(e){
        if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });
      setTimeout(function(){ input.focus(); }, 50);
    });
  };
})();

//══════════ Helpers ══════════
function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'); }
function fmtSize(b) { return b<1024?b+' B':b<1024*1024?(b/1024).toFixed(1)+' KB':(b/(1024*1024)).toFixed(1)+' MB'; }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function installElectronModule(mod) {
  var btn = document.getElementById('btnInstallAi');
  if (btn) { btn.disabled = true; btn.textContent = t('common.install.installing'); }
  try {
    var r = await fetch('/api/electron/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ module: mod }) });
    var d = await r.json();
    if (d.ok) { toast(d.message, 'success'); setTimeout(function(){ location.reload(); }, 2000); }
    else { toast(t('common.auth.opFailed2') + ': ' + (d.error || t('common.auth.unknownError')), 'error'); }
  } catch(e) { toast(t('common.auth.opFailed2') + ': ' + e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = t('common.settings.oneClickInstall'); }
}

async function checkTranslateStatus() {
  try {
    var r = await fetch('/api/translate/status'); var d = await r.json();
    var el = document.getElementById('translateModelStatus'); if (!el) return;
    if (!d.engineAvailable) { el.innerHTML = '<span style="color:var(--danger)">❌ ' + t('common.translate.engineNotInstalled') + '</span>'; }
    else {
      var parts = [];
      parts.push(d.models && d.models['en-zh'] ? '✅ ' + t('common.translate.statusEnZh') : '⬜ ' + t('common.translate.statusEnZhNotDownloaded'));
      parts.push(d.models && d.models['zh-en'] ? '✅ ' + t('common.translate.statusZhEn') : '⬜ ' + t('common.translate.statusZhEnNotDownloaded'));
      el.innerHTML = parts.join('<br>');
    }
  } catch(e) { var el2 = document.getElementById('translateModelStatus'); if (el2) el2.innerHTML = '<span style="color:var(--text-muted)">' + t('common.translate.checkFailed') + '</span>'; }
}

async function downloadTranslateModels() {
  var btn = document.getElementById('btnDownloadModels');
  if (btn) { btn.disabled = true; btn.textContent = t('common.install.downloading'); }
  try {
    var mirrorCB = document.querySelector('[data-key="translate.mirror"]');
    if (mirrorCB && mirrorCB.checked) { await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'translate.mirror', value: 'true' }) }); }
    var r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello', source_lang: 'en', target_lang: 'zh', mode: 'sentence' }) });
    if (r.ok) { toast(t('common.translate.enZhDownloaded'), 'success'); }
    else { var d = await r.json(); toast(t('common.translate.downloadFailed'), 'error'); if (btn) { btn.disabled = false; btn.textContent = t('common.settings.downloadTranslateModels'); } checkTranslateStatus(); return; }
    try { await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello', source_lang: 'zh', target_lang: 'en', mode: 'sentence' }) }); } catch(e) {}
    checkTranslateStatus();
  } catch(e) { toast(t('common.translate.downloadFailed'), 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = t('common.settings.downloadTranslateModels'); }
}

//══════════ Settings ══════════
function toggleSettings() {
  var ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  var opening = !ov.classList.contains('visible');
  ov.classList.toggle('visible');
  if (opening) {
    switchSettingsTab('system');
  }
}
function switchSettingsTab(tab) {
  document.querySelectorAll('#settingsTabs button').forEach(function(b) {
    if (b.dataset.tab === tab) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
  var c = document.getElementById('settingsContent');
  if (!c) return;
  if (tab === 'system') {
    c.innerHTML =
      '<div class="section-title">' + t('common.settings.language') + '</div>' +
      '<div class="settings-row"><span class="settings-label" data-i18n="common.settings.uiLang"></span>' +
        langSelect('uiLangSelect', 'common.settings.followGlobal') + '</div>' +
      '<div class="settings-row"><span class="settings-label" data-i18n="common.settings.globalLang"></span>' +
        langSelect('globalLangSelect', 'common.settings.autoDetect') + '</div>' +
      '<div class="section-title">' + t('common.settings.editor') + '</div>' +
      settingRow(t('common.settings.defaultEditor'),'editor.default','text','vscode') +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.transaction') + '</div>' +
      settingRow(t('common.settings.fileSizeThreshold'),'transaction.file_size_threshold_mb','number','50') +
      settingToggle(t('common.settings.enableRollback'),'transaction.rollback_enabled') +
      settingToggle('Shadow GC','transaction.shadow_gc_enabled') +
      settingRow(t('common.settings.orphanShadowTimeout'),'transaction.shadow_orphan_age_hours','number','24') +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.concurrency') + '</div>' +
      settingToggle(t('common.settings.enableProjectLock'),'concurrency.enable_project_lock') +
      settingRow(t('common.settings.lockTimeout'),'concurrency.lock_timeout_minutes','number','10') +
      settingRow(t('common.settings.heartbeatInterval'),'concurrency.lock_heartbeat_seconds','number','30') +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.sessionAndTransport') + '</div>' +
      settingRow(t('common.settings.sessionTimeout'),'session.idle_timeout_minutes','number','120') +
      settingRow(t('common.settings.cleanupInterval'),'session.cleanup_interval_minutes','number','60') +
      settingRow(t('common.settings.writeLimitPerSession'),'rate.write_limit_per_session','number','50') +
      settingRow(t('common.settings.limitWindow'),'rate.write_window_minutes','number','5') +
      (window.__doc77_caps_mcp ? (
      settingToggle('MCP stdio','transport.mcp_stdio_enabled') +
      settingToggle('MCP HTTP','transport.mcp_http_enabled') +
      settingRow(t('common.settings.mcpPort'),'transport.mcp_http_port','number','8899')) : '');
  } else if (tab === 'ai') {
    if (!window.__doc77_caps_ai) {
      var electronInstall = (window.doc77) ?
        '<button onclick="installElectronModule(\'ai\')" id="btnInstallAi" class="btn btn-primary" style="display:inline-flex;margin-top:12px;font-size:13px">' + t('common.settings.oneClickInstall') + '</button>' :
        '<code style="font-size:11px;background:var(--bg-code);padding:4px 8px;border-radius:4px;display:inline-block;margin-top:8px;color:var(--text-primary)">' + t('common.settings.installAiModuleCmd') + '</code>';
      c.innerHTML = '<div style="text-align:center;padding:32px 0;font-size:13px;color:var(--text-muted)">' + t('common.settings.aiModuleNotInstalled') + '<br>' + electronInstall + '</div>';
      return;
    }
    c.innerHTML = '<div class="section-title">' + t('common.settings.aiProvider') + '</div>' +
      '<div class="settings-row"><span class="settings-label">' + t('common.settings.provider') + '</span>' +
      '<select id="aiProvider" data-key="ai.provider" onchange="onProviderChange()" class="settings-select">' +
      '<option value="custom">' + t('common.settings.custom') + '</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option>' +
      '<option value="qwen">' + t('common.settings.qwenAlibaba') + '</option><option value="kimi">Kimi</option><option value="doubao">Doubao</option><option value="glm">' + t('common.settings.glmZhipu') + '</option></select></div>' +
      settingRow('Base URL','ai.base_url','text','https://api.deepseek.com') +
      '<div class="settings-row"><span class="settings-label">' + t('common.settings.model') + '</span>' +
      '<select id="aiModelSelect" onchange="onModelSelect(this.value)" class="settings-select">' +
      '<option value="deepseek-v4-pro">deepseek-v4-pro</option><option value="deepseek-v4-flash">deepseek-v4-flash</option></select></div>' +
      '<input data-key="ai.model" type="hidden" value="deepseek-v4-pro">' +
      settingRow(t('common.settings.apiToken'),'ai.token','password','sk-...') +
      '<div class="settings-tip" style="margin-left:4px">' + t('common.settings.tokenSavedLocally') + '</div>' +
      '<button onclick="testConnection()" style="width:100%;padding:6px 0;font-size:13px;border:1px solid var(--accent);color:var(--accent);border-radius:6px;background:transparent;cursor:pointer;margin-top:8px" onmouseover="this.style.background=\'var(--accent-light-bg)\'" onmouseout="this.style.background=\'transparent\'">' + t('common.settings.testConnection') + '</button>' +
      '<div id="testResult" style="font-size:11px;margin-top:4px"></div>' +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.aiBehavior') + '</div>' +
      settingToggle(t('common.settings.enableAi'),'ai.enabled') + settingToggle(t('common.settings.autoMode'),'ai.auto_mode') +
      settingRow(t('common.settings.riskLevel'),'ai.risk_level','select','medium','low,medium,high') +
      settingToggle(t('common.settings.confirmDelete'),'ai.confirm_delete') + settingRow(t('common.settings.batchSize'),'ai.batch_size','number','5') +
      settingRow(t('common.settings.maxDepth'),'ai.max_depth','number','5') +
      settingRow(t('common.settings.readLimitPerSession'),'ai.read_limit_per_session','number','200');
  } else if (tab === 'account') {
    c.innerHTML = '<div class="section-title">' + t('common.settings.loginPassword') + '</div>' +
      '<div id="authSection"><div style="font-size:11px;color:var(--text-muted)">' + t('common.auth.checking') + '</div></div>' +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.networkBind') + ' <span id="bindStatus" style="font-weight:400;font-size:10px"></span></div>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;line-height:1.6">' + t('common.settings.networkBindDesc') + '</div>' +
      '<div class="settings-row"><span class="settings-label">' + t('common.settings.currentBind') + '</span><span style="font-size:13px;font-family:monospace;font-weight:600;color:var(--accent)" id="runtimeBind">-</span></div>' +
      '<div class="settings-row"><span class="settings-label">' + t('common.settings.configBind') + '</span><span style="font-size:13px;font-family:monospace" id="configBind">-</span></div>' +
      settingRow('','security.bind_address','text','127.0.0.1') +
      '<input type="hidden" id="bindAddrInput" value="">' +
      '<div style="font-size:10px;color:var(--danger);margin-top:4px;display:none" id="bindMismatch">' + t('common.settings.bindMismatch') + '</div>' +
      '<div class="settings-tip">' + t('common.settings.tipRestart') + '</div>' +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.otherSecurity') + '</div>' +
      settingRow(t('common.settings.sharedSecret'),'security.shared_secret','password','') +
      settingToggle(t('common.settings.followSymlinks'),'security.follow_symlinks') +
      '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-light)"><button onclick="restartServer()" style="width:100%;padding:8px 0;font-size:13px;font-weight:500;color:var(--danger);border:1px solid var(--danger);border-radius:6px;background:transparent;cursor:pointer" onmouseover="this.style.background=\'var(--danger-light-bg)\'" onmouseout="this.style.background=\'transparent\'">' + t('common.settings.restartService') + '</button></div>';
    renderAccountSection();
    loadServerInfo();
  } else if (tab === 'translate') {
    if (!window.__doc77_caps_translate) {
      var electronInstall = (window.doc77) ? '<button onclick="installElectronModule(\'translate\')" id="btnInstallTranslate" class="btn btn-primary" style="display:inline-flex;margin-top:12px;font-size:13px">' + t('common.settings.oneClickInstallTranslate') + '</button>' : '<code style="font-size:11px;background:var(--bg-code);padding:4px 8px;border-radius:4px;display:inline-block;margin-top:8px;color:var(--text-primary)">' + t('common.settings.installTranslateCmd') + '</code>';
      c.innerHTML = '<div style="text-align:center;padding:32px 0;font-size:13px;color:var(--text-muted)">' + t('common.settings.translateModuleNotInstalled') + '<br>' + electronInstall + '</div>';
      return;
    }
    c.innerHTML =
      '<div class="section-title">' + t('common.settings.offlineTranslate') + '</div>' +
      settingToggle(t('common.settings.enableOfflineTranslate'),'translate.enabled') + settingToggle(t('common.settings.useMirror'),'translate.mirror') +
      settingRow(t('common.settings.defaultSourceLang'),'translate.default_source','text','auto') + settingRow(t('common.settings.defaultTargetLang'),'translate.default_target','text','zh') +
      settingRow(t('common.settings.maxSegmentLength'),'translate.max_segment_length','number','500') +
      '<div class="settings-tip" style="margin-left:4px">' + t('common.settings.translatePrivacy') + '</div>' +
      '<div class="section-title" style="margin-top:16px">' + t('common.settings.modelStatus') + '</div>' +
      '<div id="translateModelStatus" style="font-size:11px;color:var(--text-muted);margin-bottom:8px">' + t('common.auth.checking') + '</div>' +
      '<button onclick="downloadTranslateModels()" id="btnDownloadModels" class="btn" style="width:100%;margin-top:4px;font-size:12px">' + t('common.settings.downloadTranslateModels') + '</button>';
    checkTranslateStatus();
  }
  loadSettingsValues();
  // 回填语言下拉选值 + 翻译设置面板内的 data-i18n
  var uiSel = document.getElementById('uiLangSelect');
  if (uiSel) uiSel.value = window.__doc77_lang || '';
  var gSel = document.getElementById('globalLangSelect');
  if (gSel) gSel.value = window.__doc77_lang_global || '';
  applyI18n(c);
}

async function loadServerInfo() {
  try {
    var r = await fetch('/api/server-info');
    var d = await r.json();
    var runtimeEl = document.getElementById('runtimeBind');
    var mismatchEl = document.getElementById('bindMismatch');
    var configEl = document.getElementById('configBind');
    if (runtimeEl) {
      runtimeEl.textContent = d.bindAddress;
      runtimeEl.style.color = d.isLocal ? 'var(--accent)' : 'var(--danger)';
    }
    // Update config display after a short delay (wait for loadSettingsValues to fill)
    setTimeout(function() {
      var inp = document.querySelector('[data-key="security.bind_address"]');
      var configVal = inp ? inp.value : '';
      if (configEl) configEl.textContent = configVal || t('common.defaultValue');
      if (mismatchEl && configVal && configVal !== d.bindAddress) {
        mismatchEl.style.display = 'block';
      }
    }, 500);
  } catch(e) {}
}
function settingRow(label, key, type, placeholder, opts) {
  if (type === 'toggle') return settingToggle(label, key);
  if (type === 'select') {
    return '<div class="settings-row"><span class="settings-label">' + label + '</span>' +
      '<select data-key="' + key + '" class="settings-select">' +
      (opts||'').split(',').map(function(o){ return '<option value="'+o.trim()+'">'+o.trim()+'</option>'; }).join('') + '</select></div>';
  }
  var tt = type === 'password' ? 'password' : 'text';
  var h = '';
  if (type === 'password') h = '<button style="position:absolute;right:4px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--text-muted);border:none;background:none;cursor:pointer;line-height:1" onclick="togglePasswordView(this)">👁</button>';
  return '<div class="settings-row"><span class="settings-label">' + label + '</span>' +
    '<div style="position:relative"><input data-key="' + key + '" type="' + tt + '" placeholder="' + (placeholder||'') + '" class="input" style="width:176px">' + h + '</div></div>';
}
function settingToggle(label, key) {
  return '<div class="settings-row"><span class="settings-label">' + label + '</span>' +
    '<button data-key="' + key + '" data-value="false" onclick="toggleSwitch(this)" class="toggle-track">' +
    '<span class="toggle-knob"></span></button></div>';
}
function toggleSwitch(btn) {
  btn.dataset.value = btn.dataset.value === 'true' ? 'false' : 'true';
  btn.classList.toggle('on', btn.dataset.value === 'true');
  btn.querySelector('span').classList.toggle('on', btn.dataset.value === 'true');
}
function togglePasswordView(btn) { var i = btn.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; }

function langSelect(id, defaultLabelKey) {
  var opts = '<option value="">' + t(defaultLabelKey) + '</option>';
  (window.__doc77_locales || []).forEach(function (l) {
    opts += '<option value="' + escapeHtml(l.code) + '">' + escapeHtml(l.name) + '</option>';
  });
  return '<select id="' + id + '" onchange="onLangChange(this)" class="settings-select">' + opts + '</select>';
}
function onLangChange(sel) {
  if (sel.id === 'uiLangSelect') {
    if (sel.value) localStorage.setItem('doc77_lang', sel.value);
    else localStorage.removeItem('doc77_lang');
    location.reload();
  } else {
    // 全局语言写 config
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'locale.language', value: sel.value }),
    }).then(function () { showToast(t('common.settings.globalLangSaved')); })
      .catch(function(){ showToast(t('common.settings.globalLangSaveFailed')); });
  }
}

// AI Providers
var AI_PROVIDERS = {deepseek:{url:'https://api.deepseek.com',models:['deepseek-v4-pro','deepseek-v4-flash']},openai:{url:'https://api.openai.com/v1',models:['gpt-4o','gpt-4o-mini','gpt-5']},qwen:{url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen3-max','qwen-plus','qwen-turbo']},kimi:{url:'https://api.moonshot.cn/v1',models:['kimi-k2.7-code']},doubao:{url:'https://ark.cn-beijing.volces.com/api/v3',models:['doubao-seed-2-1-pro']},glm:{url:'https://open.bigmodel.cn/api/paas/v4',models:['glm-5.2']},custom:{url:'',models:[]}};
function onModelSelect(v) {
  var modelEl = document.querySelector('[data-key="ai.model"]');
  if (!modelEl) return;
  if (v === '_custom') {
    var m = prompt(t('common.settings.promptModelName'));
    if (m) {
      var sel = document.getElementById('aiModelSelect');
      var o = document.createElement('option');
      o.value = m; o.textContent = m; o.selected = true;
      sel.insertBefore(o, sel.lastChild);
      modelEl.value = m;
    }
  } else {
    modelEl.value = v;
  }
}
function onProviderChange() {
  var p = document.getElementById('aiProvider').value;
  var info = AI_PROVIDERS[p];
  var urlEl = document.querySelector('[data-key="ai.base_url"]');
  var sel = document.getElementById('aiModelSelect');
  var modelEl = document.querySelector('[data-key="ai.model"]');
  if (info.url) urlEl.value = info.url;
  sel.innerHTML = (info.models.length ? info.models.map(function(m){ return '<option value="'+m+'">'+m+'</option>'; }).join('') : '<option value="">' + t('common.settings.manualInput') + '</option>') +
    (p !== 'custom' ? '<option value="_custom">' + t('common.settings.other') + '</option>' : '');
  if (info.models.length) { modelEl.value = info.models[0]; sel.value = info.models[0]; }
  sel.onchange = function() { onModelSelect(this.value); };
}
async function testConnection() {
  var r = document.getElementById('testResult');
  r.textContent = t('common.ai.testing'); r.style.cssText = 'font-size:11px;color:var(--text-muted)';
  try { var res = await fetch('/api/ai/test',{method:'POST'}); var d = await res.json();
    if (d.ok) { r.textContent = t('common.ai.connected', {status: d.status}); r.style.cssText = 'font-size:11px;color:#059669'; }
    else { r.textContent = '❌ '+d.error; r.style.cssText = 'font-size:11px;color:var(--danger)'; }
  } catch(ex) { r.textContent = t('common.ai.networkError', {message: ex.message}); r.style.cssText = 'font-size:11px;color:var(--danger)'; }
}
async function loadSettingsValues() {
  try { var r = await fetch('/api/config'); var d = await r.json();
    document.querySelectorAll('#settingsContent [data-key]').forEach(function(el) {
      var k = el.dataset.key, v = d[k];
      if (v === undefined) return;
      if (el.tagName === 'SELECT') { var opt = el.querySelector('option[value="'+v+'"]'); if (opt) opt.selected = true; }
      else if (el.tagName === 'BUTTON') { el.dataset.value = v === 'true' ? 'true' : 'false'; el.classList.toggle('on', v === 'true'); if (el.querySelector('span')) el.querySelector('span').classList.toggle('on', v === 'true'); }
      else {
        // For password inputs, keep masked values as placeholder (not field value)
        // to prevent re-saving the mask in place of the real token
        if (el.type === 'password' && typeof v === 'string' && v.indexOf('•') !== -1) {
          el.placeholder = v;
          return;
        }
        el.value = v;
      }
    });
    // Refresh model dropdown to match the persisted provider
    var pv = d['ai.provider'];
    if (pv && AI_PROVIDERS[pv]) {
      var info = AI_PROVIDERS[pv];
      var sel = document.getElementById('aiModelSelect');
      var modelEl = document.querySelector('[data-key="ai.model"]');
      var savedModel = modelEl ? modelEl.value : '';
      sel.innerHTML = (info.models.length ? info.models.map(function(m){ return '<option value="'+m+'">'+m+'</option>'; }).join('') : '<option value="">' + t('common.settings.manualInput') + '</option>') +
        (pv !== 'custom' ? '<option value="_custom">' + t('common.settings.other') + '</option>' : '');
      if (info.models.length) {
        var opt = sel.querySelector('option[value="'+savedModel+'"]');
        if (opt) opt.selected = true;
        else { modelEl.value = info.models[0]; sel.value = info.models[0]; }
      }
      sel.onchange = function() { onModelSelect(this.value); };
    }
  } catch(e) {}
}
async function saveSettings() {
  var els = document.querySelectorAll('#settingsContent [data-key]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i], k = el.dataset.key, v;
    if (el.tagName === 'BUTTON') v = el.dataset.value === 'true' ? 'true' : 'false';
    else if (el.tagName === 'SELECT') v = el.value;
    else v = el.value;
    // Skip empty or still-masked sensitive fields to avoid overwriting stored values
    if (v === '' || (typeof v === 'string' && v.indexOf('•') !== -1)) {
      if (['token','secret','password','apikey','api_key','authorization'].some(function(part){ return k.toLowerCase().indexOf(part) !== -1; })) {
        continue;
      }
    }
    await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,value:v})});
  }
  toast(t('common.toast.saved'),'success');
}
async function restartServer() {
  if (!await confirmDialog(t('common.confirm.restartService'))) return;
  try {
    await saveSettings();
    await fetch('/api/restart', { method: 'POST' });
    toast(t('common.toast.restarting'), 'info');
    setTimeout(function() { location.reload(); }, 3000);
  } catch(e) { toast(t('common.toast.restartFailed'), 'error'); }
}

async function resetDefaults() {
  if (!await confirmDialog(t('common.confirm.resetDefaults'))) return;
  try { await fetch('/api/config/reset',{method:'POST'}); switchSettingsTab('system'); toast(t('common.toast.defaultsRestored'),'success'); } catch(e) { toast(t('common.toast.restoreFailed'),'error'); }
}

// Auth — Account Section
async function renderAccountSection(){
  var s = document.getElementById('authSection');
  var r = await fetch('/api/auth/status');
  var d = await r.json();

  var rsHtml = '';
  if(d.hasPassword){
    try {
      var rr = await fetch('/api/auth/recovery-status');
      var rd = await rr.json();
      if(rd.hasRecovery){
        rsHtml = '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' + t('common.auth.remainingCodes', {remaining: rd.remaining, total: rd.total}) + '</div>' +
          '<button onclick="regenerateRC()" class="btn" style="width:100%;font-size:13px;margin-top:8px">' + t('common.auth.regenerateCodes') + '</button>';
      }
    } catch(e){}
  }

  if(d.hasPassword){
    s.innerHTML = '<div style="font-size:13px;color:var(--text-primary);margin-bottom:4px">' + t('common.auth.passwordSet') + '</div>' + rsHtml +
      '<div style="margin-top:16px">' +
      '<input id="curPass" type="password" placeholder="' + t('common.auth.currentPassword') + '" class="input" style="width:100%;padding:6px 12px">' +
      '<input id="newPass" type="password" placeholder="' + t('common.auth.newPassword') + '" class="input" style="width:100%;padding:6px 12px" oninput="updateStrength()">' +
      '<div id="pwStrength" style="font-size:11px;margin:4px 0"></div>' +
      '<button onclick="changePw()" class="btn btn-primary" style="width:100%;font-size:13px">' + t('common.auth.changePassword') + '</button>' +
      '</div>' +
      '<button onclick="doLogout()" class="btn" style="color:var(--danger);width:100%;margin-top:16px;font-size:13px">' + t('common.auth.logout') + '</button>' +
      '<hr style="margin:16px 0;border-color:var(--border)">' +
      '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">' + t('common.auth.dangerZone') + '</div>' +
      '<button onclick="forceResetPw()" class="btn" style="color:var(--danger);width:100%;font-size:11px;border-color:var(--danger)">' + t('common.auth.forceResetPassword') + '</button>';
  } else {
    s.innerHTML = '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">' + t('common.auth.noPassword') + '</div>' +
      '<input id="setupPass" type="password" placeholder="' + t('common.auth.setupPasswordHint') + '" class="input" style="width:100%;padding:6px 12px">' +
      '<button onclick="setupPw()" class="btn btn-primary" style="width:100%;font-size:13px">' + t('common.auth.setupPassword') + '</button>';
  }
}
function doLogout() { sessionStorage.removeItem("doc77-auth"); location.reload(); }
async function forceResetPw() {
  if (!confirm(t('common.confirm.forceResetTitle'))) return;
  var pw = prompt(t('common.auth.enterCurrentPassword'));
  if (!pw) return;
  try {
    var r = await fetch('/api/auth/force-reset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password: pw, confirm: 'yes-i-know'})
    });
    var d = await r.json();
    if (d.ok) { alert('✅ ' + t('common.auth.securityCleared')); sessionStorage.removeItem('doc77-auth'); location.reload(); }
    else { alert('❌ ' + (d.error || t('common.auth.opFailed2'))); }
  } catch(e) { alert('❌ ' + t('common.auth.requestFailed', {message: e.message})); }
}
function updateStrength() {
  var p = (document.getElementById('newPass') && document.getElementById('newPass').value) || '';
  var s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/[0-9]/.test(p)) s++; if (/[^a-zA-Z0-9]/.test(p)) s++;
  var l = [t('common.strength.veryWeak'),t('common.strength.weak'),t('common.strength.fair'),t('common.strength.strong'),t('common.strength.veryStrong')], c = ['#ef4444','#f97316','#eab308','#84cc16','#22c55e'];
  var el = document.getElementById('pwStrength'); el.textContent = t('common.strength.prefix', {level: l[Math.min(s,4)]}); el.style.cssText = 'font-size:11px;color:' + c[Math.min(s,4)];
}
async function setupPw() {
  var p = document.getElementById('setupPass').value;
  if (p.length < 6) { toast(t('common.auth.passwordAtLeast6'),'error'); return; }
  showLoading(t('common.loading.settingPassword'));
  try {
    var r = await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
    var d = await r.json();
    if(d.ok){
      if(d.recovery_codes){ showRecoveryCodesModal(d.recovery_codes); }
      switchSettingsTab('account');
      toast(t('common.auth.setupSuccess'),'success');
    } else { toast(d.error,'error'); }
  } catch(e) { toast(t('common.auth.setupFailed', {message: e.message}),'error'); }
  hideLoading();
}
async function changePw() {
  var c = document.getElementById('curPass').value;
  var n = document.getElementById('newPass').value;
  if(!c || !n){ toast(t('common.auth.currentAndNewRequired'),'error'); return; }
  if(n.length < 6){ toast(t('common.auth.newPasswordAtLeast6'),'error'); return; }
  showLoading(t('common.loading.changingPassword'));
  try {
    var r = await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({old_password:c,new_password:n})});
    var d = await r.json();
    if(d.ok){
      if(d.recovery_codes){ showRecoveryCodesModal(d.recovery_codes); }
      switchSettingsTab('account');
      toast(t('common.auth.changed'),'success');
    } else { toast(d.error,'error'); }
  } catch(e) { toast(t('common.auth.changeFailed', {message: e.message}),'error'); }
  hideLoading();
}

async function regenerateRC(){
  var pw = await promptDialog({ title: t('common.auth.regenerateCodes'), message: t('common.auth.enterCurrentPassword'), type: 'password', placeholder: t('common.auth.currentPassword'), okText: t('common.confirm.ok') });
  if(!pw) return;
  showLoading(t('common.loading.regeneratingCodes'));
  try {
    var r = await fetch('/api/auth/recovery-codes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    var d = await r.json();
    if(d.ok && d.recovery_codes){
      showRecoveryCodesModal(d.recovery_codes);
      switchSettingsTab('account');
      toast(t('common.auth.codesRegenerated'),'success');
    } else { toast(d.error,'error'); }
  } catch(e) { toast(t('common.auth.opFailed', {message: e.message}),'error'); }
  hideLoading();
}

//══════════ Login Gate ══════════
(function(){
  if (sessionStorage.getItem("doc77-auth")) return;
  var d;
  // Wait for both auth status AND i18n dict before rendering (timing safety)
  Promise.all([
    fetch("/api/auth/status").then(function(r){ return r.json(); }),
    window.__doc77_i18n_ready
  ]).then(function(results){ d = results[0];
    if (!d.hasPassword && !d.isLegacy) { showSecurityPrompt(); return; }
    var o = document.createElement("div"); o.id = "loginGate";
    o.className = 'login-gate-bg';
    if (d.isLegacy) {
      // Legacy password — system upgraded, must re-set password with migration progress
      o.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-badge">' + t('common.login.legacyUpgrade') + '</div></div><input id="setupPass" type="password" placeholder="' + t('common.login.newPasswordHint') + '" class="login-gate-input"><button onclick="setupPwLegacy()" class="login-gate-btn">' + t('common.login.setPassword') + '</button><div id="loginError" class="login-gate-error"></div></div>';
      window.setupPwLegacy = async function() {
        var p = document.getElementById("setupPass").value;
        var e = document.getElementById("loginError");
        var btn = document.querySelector('.login-gate-btn');
        if (p.length < 6) { e.textContent = t('common.login.passwordAtLeast6'); e.style.display = 'block'; return; }
        e.style.display = 'none';

        // Show migration progress overlay
        var prog = showProgressOverlay(t('common.login.updatingSecurity'), [
          { icon: '🔐', label: t('common.login.initCrypto') },
          { icon: '🔄', label: t('common.login.migratingData') },
          { icon: '🔑', label: t('common.login.generatingCodes') },
          { icon: '✅', label: t('common.login.configComplete') }
        ]);

        // Simulate step 1 → 2 (init → migrate)
        prog.advance(1);
        // Small delay to show progress visually before the (potentially fast) API call
        await new Promise(function(r){ setTimeout(r, 400); });

        try {
          var r = await fetch("/api/auth/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});
          var rd = await r.json();
          if (rd.ok) {
            // Step 2 → 3 (codes generation)
            prog.advance(2);
            await new Promise(function(r){ setTimeout(r, 300); });
            // Step 3 → 4 (complete)
            prog.advance(3);
            prog.complete(function() {
              if (rd.recovery_codes) { showRecoveryCodesModal(rd.recovery_codes); }
              sessionStorage.setItem("doc77-auth","1");
              // Smooth exit transition
              var gate = document.getElementById("loginGate");

              // Phase 1: Glow ripple at card center
              var card = document.querySelector('.login-gate-card');
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

              // Phase 2: Gate dissolve + content reveal
              setTimeout(function() {
                if (gate) gate.classList.add('login-gate-dissolve');
                var cw = document.querySelector('.content-wrapper');
                if (cw) cw.classList.add('content-reveal');
              }, 120);

              // Phase 3: Staggered entries
              setTimeout(function() {
                var staggers = [
                  document.querySelector('.app-header'),
                  document.querySelector('.hero-banner'),
                  document.querySelector('.register-cta'),
                  document.querySelector('.recent-strip'),
                  document.querySelector('.projects-section')
                ];
                for (var si = 0; si < staggers.length; si++) {
                  if (staggers[si]) {
                    staggers[si].classList.add('stagger-in', 'stagger-delay-' + si);
                  }
                }
              }, 220);

              // Remove gate after all animations
              setTimeout(function() {
                if (o) o.remove();
              }, 700);
            });
          } else {
            prog.error(rd.error || t('common.login.setupFailed'));
          }
        } catch(ex) {
          prog.error(t('common.login.networkError', {message: ex.message}));
        }
      };
    } else {
      // Normal login
      o.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-brand-desc">' + t('common.login.tagline') + '</div></div><input id="loginPass" type="password" placeholder="' + t('common.login.enterPassword') + '" class="login-gate-input" onkeydown="if(event.key===\'Enter\')unlock()"><button onclick="unlock()" class="login-gate-btn">' + t('common.login.unlock') + '</button><div id="loginError" class="login-gate-error"></div><a href="javascript:showForgotPassword()" class="login-gate-link">' + t('common.login.forgotPassword') + '</a></div>';
      window.unlock = async function() {
        var p = document.getElementById("loginPass").value;
        var e = document.getElementById("loginError");
        var btn = document.querySelector('.login-gate-btn');
        if (!p) { e.textContent = t('common.auth.enterPassword'); e.style.display = 'block'; return; }
        // Button loading state
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
        e.style.display = 'none';
        try {
          var r2 = await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});
          var d2 = await r2.json();
          if (d2.ok) {
            sessionStorage.setItem("doc77-auth","1");
            if (d2.recovery_codes) { showRecoveryCodesModal(d2.recovery_codes); }

            // ── Glow Ripple: 3-phase login transition ──
            var gate = document.getElementById("loginGate");

            // Phase 1: Create glow ripple at card center (expands 0→full screen)
            var card = document.querySelector('.login-gate-card');
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

            // Phase 2: Dissolve gate + reveal content (staggered after ripple)
            setTimeout(function() {
              if (gate) gate.classList.add('login-gate-dissolve');
              var cw = document.querySelector('.content-wrapper');
              if (cw) cw.classList.add('content-reveal');
            }, 120);

            // Phase 3: Staggered element entries
            setTimeout(function() {
              var staggers = [
                document.querySelector('.app-header'),
                document.querySelector('.hero-banner'),
                document.querySelector('.register-cta'),
                document.querySelector('.recent-strip'),
                document.querySelector('.projects-section')
              ];
              for (var si = 0; si < staggers.length; si++) {
                if (staggers[si]) {
                  staggers[si].classList.add('stagger-in', 'stagger-delay-' + si);
                }
              }
            }, 220);

            // Remove gate from DOM after all transitions finish
            setTimeout(function() {
              if (o) o.remove();
            }, 700);
          } else if (d2.legacyMigration) {
            // Legacy hash was detected — switch to setup form
            location.reload();
          }
          else { e.textContent = d2.error || t('common.login.incorrectPassword'); e.style.display = 'block'; }
        } catch(ex) {
          e.textContent = t('common.login.networkError', {message: ex.message}); e.style.display = 'block';
        } finally {
          if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
      };
    }
    document.body.appendChild(o);
    showSecurityPrompt();
    async function showSecurityPrompt() {
      try { var sr = await fetch("/api/config"); var sd = await sr.json();
        if ((sd["ai.token"] || sd["ai.enabled"] === "true") && !d.hasPassword) {
          var sb = document.createElement("div"); sb.id = "securityBanner";
          sb.className = 'login-gate-security-banner';
          sb.innerHTML = '<span style="color:var(--accent)">⚠️ ' + t('common.login.securityBanner') + '</span>' +
            '<button onclick="this.parentElement.remove();toggleSettings();switchSettingsTab(&quot;account&quot;)" style="padding:4px 12px;background:var(--accent);color:#fff;font-size:11px;border:none;border-radius:6px;cursor:pointer;margin-left:16px;flex-shrink:0">' + t('common.login.setPassword') + '</button>';
          document.body.insertBefore(sb, document.body.firstChild);
        }
      } catch(e) {}
    }
  }).catch(function(){});
})();

//══════════ Forgot Password Flow ══════════
var forgotState = null; // null | 'verify' | 'reset'

async function showForgotPassword(){
  forgotState = 'verify';
  var h = document.getElementById("loginGate");
  if(!h) return;
  h.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-brand-desc">' + t('common.login.forgotTitle') + '</div></div>' +
    '<input id="rcInput" type="text" placeholder="' + t('common.login.recoveryCodeInput') + '" class="login-gate-input login-gate-mono-input" autocomplete="off">' +
    '<button onclick="verifyRC()" class="login-gate-btn">' + t('common.login.verifyCode') + '</button>' +
    '<div id="rcError" class="login-gate-error"></div>' +
    '<a href="javascript:location.reload()" class="login-gate-link">' + t('common.login.backToLogin') + '</a></div>';
}

async function verifyRC(){
  var rc = document.getElementById("rcInput").value.trim();
  var e = document.getElementById("rcError");
  var btn = document.querySelector('.login-gate-btn');
  if(!rc){ e.style.display="block"; e.textContent=t('common.auth.enterRecoveryCode'); return; }
  e.style.display = 'none';
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  try {
    var r = await fetch("/api/auth/forgot-password/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({recovery_code:rc})});
    var d = await r.json();
    if(d.ok){
      forgotState = 'reset';
      sessionStorage.setItem("doc77-reset-token", d.reset_token);
      showResetPassword();
    } else { e.style.display="block"; e.textContent = d.error || t('common.auth.verifyFailed'); }
  } catch(ex) { e.style.display="block"; e.textContent = t('common.auth.networkError', {message: ex.message}); }
  if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
}

function showResetPassword(){
  var h = document.getElementById("loginGate");
  if(!h) return;
  h.innerHTML = '<div class="login-gate-card"><div class="login-gate-brand"><div class="login-gate-brand-row"><img src="/assets/favicon.svg" alt="Doc77"><span class="login-gate-brand-name">Doc77</span></div><div class="login-gate-brand-desc">' + t('common.login.setNewPassword') + '</div></div>' +
    '<input id="newPw" type="password" placeholder="' + t('common.login.newPasswordHint') + '" class="login-gate-input">' +
    '<input id="newPwConfirm" type="password" placeholder="' + t('common.login.confirmNewPassword') + '" class="login-gate-input">' +
    '<button onclick="doReset()" class="login-gate-btn">' + t('common.login.resetPassword') + '</button>' +
    '<div id="resetError" class="login-gate-error"></div></div>';
}

async function doReset(){
  var p = document.getElementById("newPw").value;
  var c = document.getElementById("newPwConfirm").value;
  var e = document.getElementById("resetError");
  var btn = document.querySelector('.login-gate-btn');
  if(p.length < 6){ e.style.display="block"; e.textContent=t('common.login.passwordAtLeast6'); return; }
  if(p !== c){ e.style.display="block"; e.textContent=t('common.login.passwordsNotMatch'); return; }
  e.style.display = 'none';
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  try {
    var token = sessionStorage.getItem("doc77-reset-token");
    var r = await fetch("/api/auth/forgot-password/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reset_token:token,new_password:p})});
    var d = await r.json();
    if(d.ok){
      sessionStorage.removeItem("doc77-reset-token");
      // Show loading overlay before reload
      showLoading(t('common.loading.passwordReset'));
      setTimeout(function() { location.reload(); }, 600);
    } else { e.style.display="block"; e.textContent = d.error || t('common.auth.resetFailed'); if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; } }
  } catch(ex) { e.style.display="block"; e.textContent = t('common.login.networkError', {message: ex.message}); if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; } }
}

//══════════ Recovery Codes Modal ══════════
function showRecoveryCodesModal(codes){
  var list = document.getElementById("rcList");
  list.innerHTML = codes.map(function(c){ return '<span>' + c + '</span>'; }).join('');
  document.getElementById("recoveryModal").style.display = "flex";
}

function closeRecoveryModal(){
  document.getElementById("recoveryModal").style.display = "none";
}

async function copyRC(){
  var spans = document.querySelectorAll("#rcList span");
  var text = Array.from(spans).map(function(s){ return s.textContent; }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.toast.copied'),'success');
  } catch(e) {
    toast(t('common.toast.copyFailed'),'error');
  }
}
