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
      o.innerHTML = '<div class="confirm-box"><p style="font-size:13px;margin-bottom:16px;color:var(--text-primary)">' + msg + '</p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn cancel-btn" style="font-size:12px">取消</button>' +
        '<button class="btn btn-primary ok-btn" style="font-size:12px">确定</button></div></div>';
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

async function installElectronModule(mod) {
  var btn = document.getElementById('btnInstallAi');
  if (btn) { btn.disabled = true; btn.textContent = '安装中...'; }
  try {
    var r = await fetch('/api/electron/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ module: mod }) });
    var d = await r.json();
    if (d.ok) { toast(d.message, 'success'); setTimeout(function(){ location.reload(); }, 2000); }
    else { toast('安装失败: ' + (d.error || '未知错误'), 'error'); }
  } catch(e) { toast('安装失败: ' + e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = '📦 一键安装 AI 模块'; }
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
      '<div class="section-title">编辑器</div>' +
      settingRow('默认编辑器','editor.default','text','vscode') +
      '<div class="section-title" style="margin-top:16px">事务</div>' +
      settingRow('文件大小阈值(MB)','transaction.file_size_threshold_mb','number','50') +
      settingToggle('启用回滚','transaction.rollback_enabled') +
      settingToggle('Shadow GC','transaction.shadow_gc_enabled') +
      settingRow('孤儿Shadow超时(h)','transaction.shadow_orphan_age_hours','number','24') +
      '<div class="section-title" style="margin-top:16px">并发</div>' +
      settingToggle('项目锁','concurrency.enable_project_lock') +
      settingRow('锁超时(分钟)','concurrency.lock_timeout_minutes','number','10') +
      settingRow('心跳间隔(秒)','concurrency.lock_heartbeat_seconds','number','30') +
      '<div class="section-title" style="margin-top:16px">会话 & 传输</div>' +
      settingRow('会话超时(分钟)','session.idle_timeout_minutes','number','120') +
      settingRow('清理间隔(分钟)','session.cleanup_interval_minutes','number','60') +
      settingRow('写入限制/会话','rate.write_limit_per_session','number','50') +
      settingRow('限制窗口(分钟)','rate.write_window_minutes','number','5') +
      (window.__doc77_caps_mcp ? (
      settingToggle('MCP stdio','transport.mcp_stdio_enabled') +
      settingToggle('MCP HTTP','transport.mcp_http_enabled') +
      settingRow('MCP 端口','transport.mcp_http_port','number','8899')) : '');
  } else if (tab === 'ai') {
    if (!window.__doc77_caps_ai) {
      var electronInstall = (window.doc77) ?
        '<button onclick="installElectronModule(\'ai\')" id="btnInstallAi" class="btn btn-primary" style="display:inline-flex;margin-top:12px;font-size:13px">📦 一键安装 AI 模块</button>' :
        '<code style="font-size:11px;background:var(--bg-code);padding:4px 8px;border-radius:4px;display:inline-block;margin-top:8px;color:var(--text-primary)">doc77 i ai</code>';
      c.innerHTML = '<div style="text-align:center;padding:32px 0;font-size:13px;color:var(--text-muted)">AI 模块未安装<br>' + electronInstall + '</div>';
      return;
    }
    c.innerHTML = '<div class="section-title">AI 提供商</div>' +
      '<div class="settings-row"><span class="settings-label">提供商</span>' +
      '<select id="aiProvider" onchange="onProviderChange()" class="settings-select">' +
      '<option value="custom">自定义</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option>' +
      '<option value="qwen">Qwen (阿里)</option><option value="kimi">Kimi</option><option value="doubao">Doubao</option><option value="glm">GLM (智谱)</option></select></div>' +
      settingRow('Base URL','ai.base_url','text','https://api.deepseek.com') +
      '<div class="settings-row"><span class="settings-label">模型</span>' +
      '<select id="aiModelSelect" onchange="document.querySelector(\'[data-key=ai.model]\').value=this.value" class="settings-select">' +
      '<option value="deepseek-v4-pro">deepseek-v4-pro</option><option value="deepseek-v4-flash">deepseek-v4-flash</option></select></div>' +
      '<input data-key="ai.model" type="hidden" value="deepseek-v4-pro">' +
      settingRow('API Token','ai.token','password','sk-...') +
      '<div class="settings-tip" style="margin-left:4px">🔒 Token 仅保存在本地 SQLite 数据库</div>' +
      '<button onclick="testConnection()" style="width:100%;padding:6px 0;font-size:13px;border:1px solid var(--accent);color:var(--accent);border-radius:6px;background:transparent;cursor:pointer;margin-top:8px" onmouseover="this.style.background=\'var(--accent-light-bg)\'" onmouseout="this.style.background=\'transparent\'">🔗 测试连接</button>' +
      '<div id="testResult" style="font-size:11px;margin-top:4px"></div>' +
      '<div class="section-title" style="margin-top:16px">AI 行为</div>' +
      settingToggle('启用 AI','ai.enabled') + settingToggle('自动模式','ai.auto_mode') +
      settingRow('风险等级','ai.risk_level','select','medium','low,medium,high') +
      settingToggle('确认删除','ai.confirm_delete') + settingRow('批量大小','ai.batch_size','number','5') +
      settingRow('最大深度','ai.max_depth','number','5') +
      settingRow('每会话读取限制','ai.read_limit_per_session','number','200');
  } else if (tab === 'account') {
    c.innerHTML = '<div class="section-title">登录密码</div>' +
      '<div id="authSection"><div style="font-size:11px;color:var(--text-muted)">检查中...</div></div>' +
      '<div class="section-title" style="margin-top:16px">网络绑定 <span id="bindStatus" style="font-weight:400;font-size:10px"></span></div>' +
      '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;line-height:1.6">控制 Doc77 监听哪些网络接口。<b>127.0.0.1</b> = 仅本机访问（安全）；<b>0.0.0.0</b> = 局域网可访问（需设密码）。</div>' +
      '<div class="settings-row"><span class="settings-label">当前实际绑定</span><span style="font-size:13px;font-family:monospace;font-weight:600;color:var(--accent)" id="runtimeBind">-</span></div>' +
      '<div class="settings-row"><span class="settings-label">配置值（重启后生效）</span><span style="font-size:13px;font-family:monospace" id="configBind">-</span></div>' +
      settingRow('','security.bind_address','text','127.0.0.1') +
      '<input type="hidden" id="bindAddrInput" value="">' +
      '<div style="font-size:10px;color:var(--danger);margin-top:4px;display:none" id="bindMismatch">⚠️ 配置值与当前实际绑定不一致，重启后生效</div>' +
      '<div class="settings-tip">修改后需点击下方「重启服务」生效</div>' +
      '<div class="section-title" style="margin-top:16px">其他安全设置</div>' +
      settingRow('共享密钥','security.shared_secret','password','') +
      settingToggle('跟踪符号链接','security.follow_symlinks') +
      '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-light)"><button onclick="restartServer()" style="width:100%;padding:8px 0;font-size:13px;font-weight:500;color:var(--danger);border:1px solid var(--danger);border-radius:6px;background:transparent;cursor:pointer" onmouseover="this.style.background=\'var(--danger-light-bg)\'" onmouseout="this.style.background=\'transparent\'">🔄 重启服务</button></div>';
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
      runtimeEl.style.color = d.isLocal ? 'var(--accent)' : 'var(--danger)';
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
  r.textContent = '测试中...'; r.style.cssText = 'font-size:11px;color:var(--text-muted)';
  try { var res = await fetch('/api/ai/test',{method:'POST'}); var d = await res.json();
    if (d.ok) { r.textContent = '✅ 连接成功 ('+d.status+')'; r.style.cssText = 'font-size:11px;color:#059669'; }
    else { r.textContent = '❌ '+d.error; r.style.cssText = 'font-size:11px;color:var(--danger)'; }
  } catch(ex) { r.textContent = '❌ 网络错误: '+ex.message; r.style.cssText = 'font-size:11px;color:var(--danger)'; }
}
async function loadSettingsValues() {
  try { var r = await fetch('/api/config'); var d = await r.json();
    document.querySelectorAll('#settingsContent [data-key]').forEach(function(el) {
      var k = el.dataset.key, v = d[k];
      if (v === undefined) return;
      if (el.tagName === 'SELECT') { var opt = el.querySelector('option[value="'+v+'"]'); if (opt) opt.selected = true; }
      else if (el.tagName === 'BUTTON') { el.dataset.value = v === 'true' ? 'true' : 'false'; el.classList.toggle('on', v === 'true'); if (el.querySelector('span')) el.querySelector('span').classList.toggle('on', v === 'true'); }
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
      s.innerHTML = '<div style="font-size:12px;color:#059669;margin-bottom:8px">✅ 密码已设置</div><div style="display:flex;flex-direction:column;gap:8px">' +
        '<input id="curPass" type="password" placeholder="当前密码" class="input" style="width:100%;padding:6px 12px">' +
        '<input id="newPass" type="password" placeholder="新密码（留空不修改）" class="input" style="width:100%;padding:6px 12px" oninput="updateStrength()">' +
        '<div id="pwStrength" style="font-size:11px;color:var(--text-muted)"></div>' +
        '<button onclick="changePw()" class="btn btn-primary" style="width:100%;font-size:13px">修改密码</button></div>';
    } else {
      s.innerHTML = '<div style="font-size:12px;color:var(--danger);margin-bottom:8px">⚠️ 尚未设置密码</div><div style="display:flex;flex-direction:column;gap:8px">' +
        '<input id="setupPass" type="password" placeholder="设置密码（至少6位）" class="input" style="width:100%;padding:6px 12px">' +
        '<button onclick="setupPw()" class="btn btn-primary" style="width:100%;font-size:13px">设置密码</button></div>';
    }
    s.innerHTML += '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-light)">' +
      '<button onclick="doLogout()" style="width:100%;padding:6px 0;font-size:13px;color:var(--danger);background:transparent;border:1px solid var(--danger);border-radius:6px;cursor:pointer" onmouseover="this.style.background=\'var(--danger-light-bg)\'" onmouseout="this.style.background=\'transparent\'">🚪 退出登录</button></div>';
  } catch(e) {}
}
function doLogout() { sessionStorage.removeItem("doc77-auth"); location.reload(); }
function updateStrength() {
  var p = (document.getElementById('newPass') && document.getElementById('newPass').value) || '';
  var s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++; if (/[0-9]/.test(p)) s++; if (/[^a-zA-Z0-9]/.test(p)) s++;
  var l = ['非常弱','弱','一般','强','非常强'], c = ['#ef4444','#f97316','#eab308','#84cc16','#22c55e'];
  var el = document.getElementById('pwStrength'); el.textContent = '强度: ' + l[Math.min(s,4)]; el.style.cssText = 'font-size:11px;color:' + c[Math.min(s,4)];
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
    o.style.cssText = "position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:var(--bg-body)";
    o.innerHTML = '<div style="background:var(--bg-card);border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.2);padding:32px;width:100%;max-width:384px"><div style="text-align:center;margin-bottom:24px"><span style="font-size:36px">📁</span><h1 style="font-size:20px;font-weight:700;color:var(--text-primary);margin-top:8px;margin-bottom:0">Doc77</h1><p style="font-size:13px;color:var(--text-secondary)">请输入密码解锁</p></div><input id="loginPass" type="password" placeholder="密码" class="input" style="width:100%;padding:12px 16px;margin-bottom:12px" onkeydown="if(event.key===\'Enter\')unlock()"><button onclick="unlock()" class="btn btn-primary" style="width:100%;padding:10px 0;font-size:13px;border-radius:8px">解锁</button><div id="loginError" style="font-size:11px;color:var(--danger);margin-top:8px;text-align:center;display:none"></div></div>';
    document.body.appendChild(o);
    window.unlock = async function() {
      var p = document.getElementById("loginPass").value;
      var e = document.getElementById("loginError");
      if (!p) { e.textContent = "请输入密码"; e.style.display = 'block'; return; }
      var r2 = await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});
      var d2 = await r2.json();
      if (d2.ok) { sessionStorage.setItem("doc77-auth","1"); o.remove(); }
      else { e.textContent = d2.error || "密码错误"; e.style.display = 'block'; }
    };
    showSecurityPrompt();
    async function showSecurityPrompt() {
      try { var sr = await fetch("/api/config"); var sd = await sr.json();
        if ((sd["ai.token"] || sd["ai.enabled"] === "true") && !d.hasPassword) {
          var sb = document.createElement("div"); sb.id = "securityBanner";
          sb.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:190;background:var(--accent-light-bg);border-bottom:1px solid var(--accent);padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px";
          sb.innerHTML = '<span style="color:var(--accent)">⚠️ 已配置 AI 模型但未设置访问密码，建议设置密码保护数据安全</span>' +
            '<button onclick="this.parentElement.remove();toggleSettings();switchSettingsTab(&quot;account&quot;)" style="padding:4px 12px;background:var(--accent);color:#fff;font-size:11px;border:none;border-radius:6px;cursor:pointer;margin-left:16px;flex-shrink:0">设置密码</button>';
          document.body.insertBefore(sb, document.body.firstChild);
        }
      } catch(e) {}
    }
  }).catch(function(){});
})();
