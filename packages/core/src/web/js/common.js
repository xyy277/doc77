/**
 * Doc77 Common JS — 被 index.html 和 preview.html 共享
 * 包含: Theme, Toast/Confirm, Settings, Login Gate, Helpers
 */

// Module capabilities
window.__doc77_caps_ai = false;
window.__doc77_caps_mcp = false;
fetch('/api/capabilities').then(function(r){ return r.json(); }).then(function(c){
  window.__doc77_caps_ai = c.ai;
  window.__doc77_caps_mcp = c.mcp;
}).catch(function(){});

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
      o.innerHTML = '<div class="confirm-box"><p class="text-sm mb-4">' + msg + '</p>' +
        '<div class="flex gap-2 justify-end">' +
        '<button class="px-4 py-2 text-sm bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-md hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors cancel-btn">取消</button>' +
        '<button class="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors ok-btn">确定</button></div></div>';
      document.body.appendChild(o);
      o.querySelector('.ok-btn').onclick = function(){ o.remove(); resolve(true); };
      o.querySelector('.cancel-btn').onclick = function(){ o.remove(); resolve(false); };
      o.addEventListener('click', function(e){ if (e.target === o) { o.remove(); resolve(false); } });
    });
  };
})();

//══════════ Helpers ══════════
function esc(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'); }
function fmtSize(b) { return b<1024?b+' B':b<1024*1024?(b/1024).toFixed(1)+' KB':(b/(1024*1024)).toFixed(1)+' MB'; }

//══════════ Settings ══════════
function toggleSettings() {
  var ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  var opening = !ov.classList.contains('visible');
  ov.classList.toggle('visible');
  // Show/hide nested elements with transitions
  var backdrop = ov.querySelector('.settings-backdrop');
  var panel = ov.querySelector('.settings-panel');
  if (opening) {
    ov.classList.remove('pointer-events-none');
    if (backdrop) backdrop.classList.remove('opacity-0');
    if (panel) panel.classList.remove('translate-x-full');
    switchSettingsTab('system');
  } else {
    if (backdrop) backdrop.classList.add('opacity-0');
    if (panel) panel.classList.add('translate-x-full');
    // Delay pointer events removal to allow transition
    setTimeout(function() { ov.classList.add('pointer-events-none'); }, 300);
  }
}
function switchSettingsTab(tab) {
  document.querySelectorAll('#settingsTabs button').forEach(function(b) {
    var a = b.dataset.tab === tab;
    b.className = 'flex-1 py-2.5 text-xs font-medium transition-colors ' +
      (a ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' :
           'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200');
  });
  var c = document.getElementById('settingsContent');
  if (!c) return;
  if (tab === 'system') {
    c.innerHTML = '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">编辑器</div><div class="space-y-3">' +
      settingRow('默认编辑器','editor.default','text','vscode') + '</div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">事务</div><div class="space-y-3">' +
      settingRow('文件大小阈值(MB)','transaction.file_size_threshold_mb','number','50') +
      settingToggle('启用回滚','transaction.rollback_enabled') +
      settingToggle('Shadow GC','transaction.shadow_gc_enabled') +
      settingRow('孤儿Shadow超时(h)','transaction.shadow_orphan_age_hours','number','24') + '</div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">并发</div><div class="space-y-3">' +
      settingToggle('项目锁','concurrency.enable_project_lock') +
      settingRow('锁超时(分钟)','concurrency.lock_timeout_minutes','number','10') +
      settingRow('心跳间隔(秒)','concurrency.lock_heartbeat_seconds','number','30') + '</div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">会话 & 传输</div><div class="space-y-3">' +
      settingRow('会话超时(分钟)','session.idle_timeout_minutes','number','120') +
      settingRow('清理间隔(分钟)','session.cleanup_interval_minutes','number','60') +
      settingRow('写入限制/会话','rate.write_limit_per_session','number','50') +
      settingRow('限制窗口(分钟)','rate.write_window_minutes','number','5') +
      (window.__doc77_caps_mcp ? (
      settingToggle('MCP stdio','transport.mcp_stdio_enabled') +
      settingToggle('MCP HTTP','transport.mcp_http_enabled') +
      settingRow('MCP 端口','transport.mcp_http_port','number','8899')) : '') + '</div>';
  } else if (tab === 'ai') {
    if (!window.__doc77_caps_ai) {
      c.innerHTML = '<div class="text-center py-8 text-slate-500 text-sm">AI 模块未安装<br><code class="text-xs bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded mt-2 inline-block">doc77 i ai</code></div>';
      return;
    }
    c.innerHTML = '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">AI 提供商</div><div class="space-y-3">' +
      '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">提供商</span>' +
      '<select id="aiProvider" onchange="onProviderChange()" class="w-44 border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' +
      '<option value="custom">自定义</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option>' +
      '<option value="qwen">Qwen (阿里)</option><option value="kimi">Kimi</option><option value="doubao">Doubao</option><option value="glm">GLM (智谱)</option></select></div>' +
      settingRow('Base URL','ai.base_url','text','https://api.deepseek.com') +
      '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">模型</span>' +
      '<select id="aiModelSelect" onchange="document.querySelector(\'[data-key=ai.model]\').value=this.value" class="w-44 border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' +
      '<option value="deepseek-v4-pro">deepseek-v4-pro</option><option value="deepseek-v4-flash">deepseek-v4-flash</option></select></div>' +
      '<input data-key="ai.model" type="hidden" value="deepseek-v4-pro">' +
      settingRow('API Token','ai.token','password','sk-...') +
      '<div class="text-[10px] text-slate-400 -mt-2 ml-1">🔒 Token 仅保存在本地 SQLite 数据库</div>' +
      '<button onclick="testConnection()" class="w-full py-1.5 text-sm border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">🔗 测试连接</button>' +
      '<div id="testResult" class="text-xs"></div></div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">AI 行为</div><div class="space-y-3">' +
      settingToggle('启用 AI','ai.enabled') + settingToggle('自动模式','ai.auto_mode') +
      settingRow('风险等级','ai.risk_level','select','medium','low,medium,high') +
      settingToggle('确认删除','ai.confirm_delete') + settingRow('批量大小','ai.batch_size','number','5') +
      settingRow('最大深度','ai.max_depth','number','5') +
      settingRow('每会话读取限制','ai.read_limit_per_session','number','200') + '</div>';
  } else if (tab === 'account') {
    c.innerHTML = '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">登录密码</div>' +
      '<div class="space-y-3" id="authSection"><div class="text-xs text-slate-400">检查中...</div></div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">网络绑定 <span id="bindStatus" class="font-normal text-[10px]"></span></div>' +
      '<div class="text-xs text-slate-500 mb-2 leading-relaxed">控制 Doc77 监听哪些网络接口。<b>127.0.0.1</b> = 仅本机访问（安全）；<b>0.0.0.0</b> = 局域网可访问（需设密码）。</div>' +
      '<div class="space-y-2">' +
      '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">当前实际绑定</span><span class="text-sm font-mono font-semibold text-blue-600 dark:text-blue-400" id="runtimeBind">-</span></div>' +
      '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">配置值（重启后生效）</span><span class="text-sm font-mono" id="configBind">-</span></div>' +
      settingRow('','security.bind_address','text','127.0.0.1') +
      '<input type="hidden" id="bindAddrInput" value="">' +
      '</div>' +
      '<div class="text-[10px] text-amber-600 dark:text-amber-400 mt-1 ml-1" id="bindMismatch" style="display:none">⚠️ 配置值与当前实际绑定不一致，重启后生效</div>' +
      '<div class="text-[10px] text-slate-400 mt-1 ml-1">修改后需点击下方「重启服务」生效</div>' +
      '<div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-4 mb-2">其他安全设置</div><div class="space-y-3">' +
      settingRow('共享密钥','security.shared_secret','password','') +
      settingToggle('跟踪符号链接','security.follow_symlinks') + '</div>' +
      '<div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700"><button onclick="restartServer()" class="w-full py-2 text-sm font-medium text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-700 rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">🔄 重启服务</button></div>';
    loadAuthStatus();
    loadServerInfo();
  }
  loadSettingsValues();
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
      runtimeEl.className = 'text-sm font-mono font-semibold ' + (d.isLocal ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400');
    }
    // Update config display after a short delay (wait for loadSettingsValues to fill)
    setTimeout(function() {
      var inp = document.querySelector('[data-key="security.bind_address"]');
      var configVal = inp ? inp.value : '';
      if (configEl) configEl.textContent = configVal || '127.0.0.1 (默认)';
      if (mismatchEl && configVal && configVal !== d.bindAddress) {
        mismatchEl.style.display = 'block';
      }
    }, 500);
  } catch(e) {}
}
function settingRow(label, key, type, placeholder, opts) {
  if (type === 'toggle') return settingToggle(label, key);
  if (type === 'select') {
    return '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">' + label + '</span>' +
      '<select data-key="' + key + '" class="w-40 border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' +
      (opts||'').split(',').map(function(o){ return '<option value="'+o.trim()+'">'+o.trim()+'</option>'; }).join('') + '</select></div>';
  }
  var tt = type === 'password' ? 'password' : 'text';
  var h = '';
  if (type === 'password') h = '<button class="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600" onclick="togglePasswordView(this)">👁</button>';
  return '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">' + label + '</span>' +
    '<div class="relative"><input data-key="' + key + '" type="' + tt + '" placeholder="' + (placeholder||'') + '" class="w-44 border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' + h + '</div></div>';
}
function settingToggle(label, key) {
  return '<div class="flex items-center justify-between"><span class="text-sm text-slate-600 dark:text-slate-400">' + label + '</span>' +
    '<button data-key="' + key + '" data-value="false" onclick="toggleSwitch(this)" class="w-10 h-5 rounded-full bg-slate-300 dark:bg-slate-600 relative transition-colors">' +
    '<span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"></span></button></div>';
}
function toggleSwitch(btn) {
  btn.dataset.value = btn.dataset.value === 'true' ? 'false' : 'true';
  btn.className = btn.dataset.value === 'true' ?
    'w-10 h-5 rounded-full bg-blue-600 relative transition-colors' :
    'w-10 h-5 rounded-full bg-slate-300 dark:bg-slate-600 relative transition-colors';
  btn.querySelector('span').style.transform = btn.dataset.value === 'true' ? 'translateX(20px)' : 'translateX(0)';
}
function togglePasswordView(btn) { var i = btn.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; }

// AI Providers
var AI_PROVIDERS = {deepseek:{url:'https://api.deepseek.com',models:['deepseek-v4-pro','deepseek-v4-flash']},openai:{url:'https://api.openai.com/v1',models:['gpt-4o','gpt-4o-mini','gpt-5']},qwen:{url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen3-max','qwen-plus','qwen-turbo']},kimi:{url:'https://api.moonshot.cn/v1',models:['kimi-k2.7-code']},doubao:{url:'https://ark.cn-beijing.volces.com/api/v3',models:['doubao-seed-2-1-pro']},glm:{url:'https://open.bigmodel.cn/api/paas/v4',models:['glm-5.2']},custom:{url:'',models:[]}};
function onProviderChange() {
  var p = document.getElementById('aiProvider').value;
  var info = AI_PROVIDERS[p];
  var urlEl = document.querySelector('[data-key=ai.base_url]');
  var sel = document.getElementById('aiModelSelect');
  var modelEl = document.querySelector('[data-key=ai.model]');
  if (info.url) urlEl.value = info.url;
  sel.innerHTML = (info.models.length ? info.models.map(function(m){ return '<option value="'+m+'">'+m+'</option>'; }).join('') : '<option value="">(手动输入)</option>') +
    (p !== 'custom' ? '<option value="_custom">(其他...)</option>' : '');
  if (info.models.length) { modelEl.value = info.models[0]; sel.value = info.models[0]; }
  sel.onchange = function() {
    if (this.value === '_custom') { var m = prompt('输入模型名称:'); if (m) { var o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = true; this.insertBefore(o, this.lastChild); modelEl.value = m; } }
    else { modelEl.value = this.value; }
  };
}
async function testConnection() {
  var r = document.getElementById('testResult');
  r.textContent = '测试中...'; r.className = 'text-xs text-slate-500';
  try { var res = await fetch('/api/ai/test',{method:'POST'}); var d = await res.json();
    if (d.ok) { r.textContent = '✅ 连接成功 ('+d.status+')'; r.className = 'text-xs text-green-500'; }
    else { r.textContent = '❌ '+d.error; r.className = 'text-xs text-red-500'; }
  } catch(ex) { r.textContent = '❌ 网络错误: '+ex.message; r.className = 'text-xs text-red-500'; }
}
async function loadSettingsValues() {
  try { var r = await fetch('/api/config'); var d = await r.json();
    document.querySelectorAll('#settingsContent [data-key]').forEach(function(el) {
      var k = el.dataset.key, v = d[k];
      if (v === undefined) return;
      if (el.tagName === 'SELECT') { var opt = el.querySelector('option[value="'+v+'"]'); if (opt) opt.selected = true; }
      else if (el.tagName === 'BUTTON') { el.dataset.value = v === 'true' ? 'true' : 'false'; el.className = el.dataset.value === 'true' ? 'w-10 h-5 rounded-full bg-blue-600 relative transition-colors' : 'w-10 h-5 rounded-full bg-slate-300 dark:bg-slate-600 relative transition-colors'; el.querySelector('span').style.transform = el.dataset.value === 'true' ? 'translateX(20px)' : 'translateX(0)'; }
      else el.value = v;
    });
  } catch(e) {}
}
async function saveSettings() {
  var els = document.querySelectorAll('#settingsContent [data-key]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i], k = el.dataset.key, v;
    if (el.tagName === 'BUTTON') v = el.dataset.value === 'true' ? 'true' : 'false';
    else if (el.tagName === 'SELECT') v = el.value;
    else v = el.value;
    await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,value:v})});
  }
  toast('设置已保存','success');
}
async function restartServer() {
  if (!await confirmDialog('确定重启服务？正在进行的操作会中断，浏览器需要刷新页面重新连接。')) return;
  try {
    await saveSettings();
    await fetch('/api/restart', { method: 'POST' });
    toast('服务正在重启，3 秒后自动刷新...', 'info');
    setTimeout(function() { location.reload(); }, 3000);
  } catch(e) { toast('重启失败', 'error'); }
}

async function resetDefaults() {
  if (!await confirmDialog('确定恢复所有默认设置？')) return;
  try { await fetch('/api/config/reset',{method:'POST'}); switchSettingsTab('system'); toast('已恢复默认值','success'); } catch(e) { toast('恢复失败','error'); }
}

// Auth
async function loadAuthStatus() {
  try { var r = await fetch('/api/auth/status'); var d = await r.json(); var s = document.getElementById('authSection');
    if (d.hasPassword) {
      s.innerHTML = '<div class="text-xs text-green-600 mb-2">✅ 密码已设置</div><div class="space-y-2">' +
        '<input id="curPass" type="password" placeholder="当前密码" class="w-full border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' +
        '<input id="newPass" type="password" placeholder="新密码（留空不修改）" class="w-full border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200" oninput="updateStrength()">' +
        '<div id="pwStrength" class="text-xs text-slate-400"></div>' +
        '<button onclick="changePw()" class="w-full py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors">修改密码</button></div>';
    } else {
      s.innerHTML = '<div class="text-xs text-amber-600 mb-2">⚠️ 尚未设置密码</div><div class="space-y-2">' +
        '<input id="setupPass" type="password" placeholder="设置密码（至少6位）" class="w-full border border-slate-200 dark:border-slate-600 rounded-md px-2 py-1.5 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200">' +
        '<button onclick="setupPw()" class="w-full py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors">设置密码</button></div>';
    }
    s.innerHTML += '<div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">' +
      '<button onclick="doLogout()" class="w-full py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors">🚪 退出登录</button></div>';
  } catch(e) {}
}
function doLogout() { sessionStorage.removeItem("doc77-auth"); location.reload(); }
function updateStrength() {
  var p = (document.getElementById('newPass') && document.getElementById('newPass').value) || '';
  var s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/[0-9]/.test(p)) s++; if (/[^a-zA-Z0-9]/.test(p)) s++;
  var l = ['非常弱','弱','一般','强','非常强'], c = ['text-red-500','text-orange-500','text-yellow-500','text-lime-500','text-green-500'];
  var el = document.getElementById('pwStrength'); el.textContent = '强度: ' + l[Math.min(s,4)]; el.className = 'text-xs ' + c[Math.min(s,4)];
}
async function setupPw() {
  var p = document.getElementById('setupPass').value;
  if (p.length < 6) { toast('密码至少6位','error'); return; }
  var r = await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
  var d = await r.json(); if (d.ok) { toast('密码已设置','success'); loadAuthStatus(); } else toast(d.error,'error');
}
async function changePw() {
  var c = document.getElementById('curPass').value, n = document.getElementById('newPass').value;
  if (!c || !n) { toast('请填写当前密码和新密码','error'); return; }
  if (n.length < 6) { toast('新密码至少6位','error'); return; }
  var r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:c})});
  var d = await r.json(); if (!d.ok) { toast('当前密码错误','error'); return; }
  var r2 = await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:n})});
  var d2 = await r2.json(); if (d2.ok) { toast('密码已修改','success'); loadAuthStatus(); } else toast(d2.error,'error');
}

//══════════ Login Gate ══════════
(function(){
  if (sessionStorage.getItem("doc77-auth")) return;
  var d;
  fetch("/api/auth/status").then(function(r){ return r.json(); }).then(function(data){ d = data;
    if (!d.hasPassword) { showSecurityPrompt(); return; }
    var o = document.createElement("div"); o.id = "loginGate";
    o.className = "fixed inset-0 z-[200] bg-slate-50 dark:bg-slate-950 flex items-center justify-center";
    o.innerHTML = '<div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl p-8 w-full max-w-sm"><div class="text-center mb-6"><span class="text-4xl">📁</span><h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 mt-2">Doc77</h1><p class="text-sm text-slate-500 dark:text-slate-400">请输入密码解锁</p></div><input id="loginPass" type="password" placeholder="密码" class="w-full border border-slate-200 dark:border-slate-600 rounded-lg px-4 py-3 text-sm bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 mb-3" onkeydown="if(event.key===\'Enter\')unlock()"><button onclick="unlock()" class="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">解锁</button><div id="loginError" class="text-xs text-red-500 mt-2 text-center hidden"></div></div>';
    document.body.appendChild(o);
    window.unlock = async function() {
      var p = document.getElementById("loginPass").value;
      var e = document.getElementById("loginError");
      if (!p) { e.textContent = "请输入密码"; e.classList.remove("hidden"); return; }
      var r2 = await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});
      var d2 = await r2.json();
      if (d2.ok) { sessionStorage.setItem("doc77-auth","1"); o.remove(); }
      else { e.textContent = d2.error || "密码错误"; e.classList.remove("hidden"); }
    };
    showSecurityPrompt();
    async function showSecurityPrompt() {
      try { var sr = await fetch("/api/config"); var sd = await sr.json();
        if ((sd["ai.token"] || sd["ai.enabled"] === "true") && !d.hasPassword) {
          var sb = document.createElement("div"); sb.id = "securityBanner";
          sb.className = "fixed top-0 left-0 right-0 z-[190] bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2 flex items-center justify-between text-sm";
          sb.innerHTML = '<span class="text-amber-800 dark:text-amber-200">⚠️ 已配置 AI 模型但未设置访问密码，建议设置密码保护数据安全</span>' +
            '<button onclick="this.parentElement.remove();toggleSettings();switchSettingsTab(&quot;account&quot;)" class="px-3 py-1 bg-amber-600 text-white text-xs rounded-md hover:bg-amber-700 transition-colors shrink-0 ml-4">设置密码</button>';
          document.body.insertBefore(sb, document.body.firstChild);
        }
      } catch(e) {}
    }
  }).catch(function(){});
})();
