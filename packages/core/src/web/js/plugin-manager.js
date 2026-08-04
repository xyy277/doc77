/**
 * T15: 插件管理前端 UI — 列表/安装/卸载/启用/禁用/配置
 * 文案经 window.t() / data-i18n 提取（zh-CN.json / en-US.json 同步维护）。
 */
(function () {
  'use strict';
  async function fetchJson(url, opts) { const res = await fetch(url, opts); return res.json(); }
  function showToast(msg, type) { const el = document.createElement('div'); el.className = `toast toast-${type || 'success'}`; el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

  async function loadPlugins() {
    try {
      const data = await fetchJson('/api/plugins');
      const list = document.getElementById('plugin-list');
      if (!list) return;
      if (!data.plugins || data.plugins.length === 0) {
        list.innerHTML = `<p class="text-muted">${t('plugins.none')}</p>`;
        return;
      }
      list.innerHTML = data.plugins.map((p) => `
        <div class="plugin-item" data-name="${p.name}">
          <div class="plugin-info">
            <strong>${p.name}</strong> <span class="text-muted">v${p.version} (${p.type})</span>
          </div>
          <div class="plugin-actions">
            <label class="switch">
              <input type="checkbox" ${p.enabled ? 'checked' : ''} data-toggle="${p.name}">
              <span class="slider"></span>
            </label>
            <button class="btn btn-sm btn-danger" data-remove="${p.name}">${t('plugins.uninstall')}</button>
          </div>
        </div>`).join('');
      // 绑定事件
      list.querySelectorAll('[data-toggle]').forEach((cb) => {
        cb.addEventListener('change', async (e) => {
          const name = e.target.getAttribute('data-toggle');
          const enabled = e.target.checked;
          await fetchJson(`/api/plugins/${name}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
          showToast(t(enabled ? 'plugins.enabled' : 'plugins.disabled', { name }));
        });
      });
      list.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const name = e.target.getAttribute('data-remove');
          if (!confirm(t('plugins.confirmRemove', { name }))) return;
          await fetchJson(`/api/plugins/${name}`, { method: 'DELETE' });
          showToast(t('plugins.removed', { name }));
          loadPlugins();
        });
      });
    } catch (e) { console.error('[plugin-manager] load failed:', e); }
  }

  async function installPlugin() {
    const name = document.getElementById('plugin-install-name').value.trim();
    const version = document.getElementById('plugin-install-version').value.trim() || '1.0.0';
    const type = document.getElementById('plugin-install-type').value;
    if (!name) { showToast(t('plugins.nameRequired'), 'error'); return; }
    try {
      await fetchJson('/api/plugins/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version, type, source: 'web' }) });
      showToast(t('plugins.installed', { name }));
      document.getElementById('plugin-install-name').value = '';
      loadPlugins();
    } catch (e) { showToast(t('plugins.installFailed'), 'error'); }
  }

  window.initPluginManager = function (container) {
    container.innerHTML = `
      <div class="plugin-manager">
        <h3 data-i18n="plugins.title"></h3>
        <div class="form-group">
          <div class="row">
            <div class="col"><input type="text" id="plugin-install-name" class="form-control" data-i18n-placeholder="plugins.namePlaceholder"></div>
            <div class="col"><input type="text" id="plugin-install-version" class="form-control" data-i18n-placeholder="plugins.versionPlaceholder"></div>
            <div class="col"><select id="plugin-install-type" class="form-control"><option value="renderer" data-i18n="plugins.typeRenderer"></option><option value="theme" data-i18n="plugins.typeTheme"></option></select></div>
            <div class="col"><button class="btn btn-primary" id="plugin-install-btn" data-i18n="plugins.installBtn"></button></div>
          </div>
        </div>
        <div id="plugin-list" class="plugin-list"><p class="text-muted" data-i18n="plugins.loading"></p></div>
      </div>`;
    applyI18n(container);
    document.getElementById('plugin-install-btn').addEventListener('click', installPlugin);
    loadPlugins();
  };
})();
