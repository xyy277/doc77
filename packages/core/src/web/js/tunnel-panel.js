/**
 * T12: 隧道配置前端面板
 *
 * 功能：
 * - 配置 provider、token、accessPolicy
 * - 查看隧道 URL
 * - 管理设备（查看活跃 session）
 *
 * 挂载方式：在设置页面新增"隧道"标签页，调用 initTunnelPanel(container)
 * 文案经 window.t() / data-i18n 提取（zh-CN.json / en-US.json 同步维护）。
 */
(function () {
  'use strict';

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
  }

  async function loadConfig() {
    try {
      const config = await fetchJson('/api/tunnel/config');
      document.getElementById('tunnel-access-policy').value = config.accessPolicy || 'open';
      document.getElementById('tunnel-session-ttl').value = config.sessionTtlMinutes || 30;
      document.getElementById('tunnel-password').value = '';
      document.getElementById('tunnel-password').placeholder = config.password
        ? t('tunnel.passwordSetPlaceholder')
        : t('tunnel.passwordPlaceholder');
      const deviceList = document.getElementById('tunnel-devices-list');
      if (deviceList) {
        deviceList.innerHTML = (config.allowedDevices || [])
          .map((d) => `<li>${d}</li>`)
          .join('') || `<li class="text-muted">${t('tunnel.noLimit')}</li>`;
      }
    } catch (e) {
      console.error('[tunnel-panel] load config failed:', e);
    }
  }

  async function saveConfig() {
    const config = {
      accessPolicy: document.getElementById('tunnel-access-policy').value,
      sessionTtlMinutes: parseInt(document.getElementById('tunnel-session-ttl').value, 10) || 30,
    };
    const pwd = document.getElementById('tunnel-password').value;
    if (pwd) config.password = pwd;
    try {
      await fetchJson('/api/tunnel/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      showToast(t('tunnel.saved'));
    } catch (e) {
      showToast(t('tunnel.saveFailed', { message: e.message }), 'error');
    }
  }

  async function loadStatus() {
    try {
      const status = await fetchJson('/api/tunnel/status');
      const statusEl = document.getElementById('tunnel-status');
      if (statusEl) {
        statusEl.textContent = status.status === 'running' ? t('tunnel.running') : t('tunnel.stopped');
        statusEl.className = status.status === 'running' ? 'badge badge-success' : 'badge badge-muted';
      }
      const urlEl = document.getElementById('tunnel-url');
      if (urlEl) {
        urlEl.textContent = status.url || '—';
      }
    } catch (e) {
      console.error('[tunnel-panel] load status failed:', e);
    }
  }

  async function loadDevices() {
    try {
      const data = await fetchJson('/api/tunnel/devices');
      const list = document.getElementById('tunnel-active-devices');
      if (list) {
        list.innerHTML = (data.devices || [])
          .map((d) => `<li>${d.userAgent || d.ip || t('tunnel.unknownDevice')}</li>`)
          .join('') || `<li class="text-muted">${t('tunnel.noActiveDevices')}</li>`;
      }
    } catch (e) {
      console.error('[tunnel-panel] load devices failed:', e);
    }
  }

  function showToast(msg, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'success'}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  window.initTunnelPanel = function (container) {
    container.innerHTML = `
      <div class="tunnel-panel">
        <h3 data-i18n="tunnel.title"></h3>
        <div class="form-group">
          <label data-i18n="tunnel.status"></label>
          <span id="tunnel-status" class="badge badge-muted">—</span>
          <span>${t('tunnel.url')}: <code id="tunnel-url">—</code></span>
        </div>
        <div class="form-group">
          <label data-i18n="tunnel.accessPolicy"></label>
          <select id="tunnel-access-policy" class="form-control">
            <option value="open" data-i18n="tunnel.accessOpen"></option>
            <option value="readonly" data-i18n="tunnel.accessReadonly"></option>
            <option value="password" data-i18n="tunnel.accessPassword"></option>
          </select>
        </div>
        <div class="form-group">
          <label data-i18n="tunnel.passwordLabel"></label>
          <input type="password" id="tunnel-password" class="form-control" data-i18n-placeholder="tunnel.passwordPlaceholder">
        </div>
        <div class="form-group">
          <label data-i18n="tunnel.sessionTtl"></label>
          <input type="number" id="tunnel-session-ttl" class="form-control" value="30" min="5" max="1440">
        </div>
        <div class="form-group">
          <label data-i18n="tunnel.allowedDevices"></label>
          <ul id="tunnel-devices-list" class="device-list">
            <li class="text-muted" data-i18n="tunnel.loading"></li>
          </ul>
        </div>
        <div class="form-group">
          <label data-i18n="tunnel.activeDevices"></label>
          <ul id="tunnel-active-devices" class="device-list">
            <li class="text-muted" data-i18n="tunnel.loading"></li>
          </ul>
        </div>
        <button class="btn btn-primary" id="tunnel-save-btn" data-i18n="tunnel.saveBtn"></button>
      </div>
    `;
    applyI18n(container);
    document.getElementById('tunnel-save-btn').addEventListener('click', saveConfig);
    loadConfig();
    loadStatus();
    loadDevices();
  };
})();
