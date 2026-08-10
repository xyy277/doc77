/**
 * T14: 同步配置前端面板
 * 功能：配置适配器、测试连接、触发同步、查看状态/日志
 * 文案经 window.t() / data-i18n 提取（zh-CN.json / en-US.json 同步维护）。
 */
(function () {
  'use strict';
  async function fetchJson(url, opts) { const res = await fetch(url, opts); return res.json(); }

  async function loadConfigs() {
    try {
      const data = await fetchJson('/api/sync/configs/1');
      if (data.config) {
        document.getElementById('sync-adapter-type').value = data.config.adapter_type || 'local';
        document.getElementById('sync-direction').value = data.config.direction || 'bidirectional';
      }
    } catch (e) { /* no config yet */ }
  }
  async function loadState() {
    try {
      const data = await fetchJson('/api/sync/state/1');
      const el = document.getElementById('sync-state');
      if (el) {
        el.textContent = data.state
          ? t('sync.state', {
              status: data.state.status,
              pushed: data.state.total_pushed,
              pulled: data.state.total_pulled,
            })
          : t('sync.notSynced');
      }
    } catch (e) { /* ignore */ }
  }
  async function saveConfig() {
    const config = {
      adapter_type: document.getElementById('sync-adapter-type').value,
      config_json: document.getElementById('sync-config-json').value,
      direction: document.getElementById('sync-direction').value,
      interval_seconds: parseInt(document.getElementById('sync-interval').value, 10) || 1800,
      enabled: 1,
    };
    try { await fetchJson('/api/sync/configs/1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }); showToast(t('sync.saved')); }
    catch (e) { showToast(t('sync.saveFailed'), 'error'); }
  }
  async function testConnection() {
    const body = { adapter_type: document.getElementById('sync-adapter-type').value, config_json: document.getElementById('sync-config-json').value };
    try { const result = await fetchJson('/api/sync/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); showToast(result.ok ? t('sync.connected') : t('sync.connectFailed', { message: result.message })); }
    catch (e) { showToast(t('sync.testFailed'), 'error'); }
  }
  async function runSync() {
    try { const result = await fetchJson('/api/sync/run/1', { method: 'POST' }); showToast(t('sync.synced', { pushed: result.result.pushed, pulled: result.result.pulled })); loadState(); }
    catch (e) { showToast(t('sync.syncFailed'), 'error'); }
  }
  function showToast(msg, type) { const el = document.createElement('div'); el.className = `toast toast-${type || 'success'}`; el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

  window.initSyncPanel = function (container) {
    container.innerHTML = `
      <div class="sync-panel">
        <h3 data-i18n="sync.title"></h3>
        <div class="form-group"><label data-i18n="sync.adapterType"></label><select id="sync-adapter-type" class="form-control"><option value="local" data-i18n="sync.adapterLocal"></option><option value="webdav" data-i18n="sync.adapterWebdav"></option><option value="s3" data-i18n="sync.adapterS3"></option><option value="git" data-i18n="sync.adapterGit"></option></select></div>
        <div class="form-group"><label data-i18n="sync.configJson"></label><textarea id="sync-config-json" class="form-control" rows="3" placeholder='{"type":"local","targetPath":"/path/to/target"}'></textarea></div>
        <div class="form-group"><label data-i18n="sync.direction"></label><select id="sync-direction" class="form-control"><option value="bidirectional" data-i18n="sync.directionBidirectional"></option><option value="push" data-i18n="sync.directionPush"></option><option value="pull" data-i18n="sync.directionPull"></option></select></div>
        <div class="form-group"><label data-i18n="sync.interval"></label><input type="number" id="sync-interval" class="form-control" value="1800" min="0"></div>
        <div class="form-group"><span id="sync-state" class="text-muted" data-i18n="sync.loading"></span></div>
        <button class="btn btn-primary" id="sync-save-btn" data-i18n="sync.saveBtn"></button>
        <button class="btn btn-secondary" id="sync-test-btn" data-i18n="sync.testBtn"></button>
        <button class="btn btn-success" id="sync-run-btn" data-i18n="sync.runBtn"></button>
      </div>`;
    applyI18n(container);
    document.getElementById('sync-save-btn').addEventListener('click', saveConfig);
    document.getElementById('sync-test-btn').addEventListener('click', testConnection);
    document.getElementById('sync-run-btn').addEventListener('click', runSync);
    loadConfigs(); loadState();
  };
})();
