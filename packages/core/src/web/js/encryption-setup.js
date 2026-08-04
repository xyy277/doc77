/**
 * T14: E2EE 加密设置 UI — keyring setup/unlock
 * 文案经 window.t() / data-i18n 提取（zh-CN.json / en-US.json 同步维护）。
 */
(function () {
  'use strict';
  async function fetchJson(url, opts) { const res = await fetch(url, opts); return res.json(); }
  function showToast(msg, type) { const el = document.createElement('div'); el.className = `toast toast-${type || 'success'}`; el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

  window.initEncryptionSetup = function (container) {
    container.innerHTML = `
      <div class="encryption-setup">
        <h3 data-i18n="enc.title"></h3>
        <div id="enc-status" class="text-muted" data-i18n="enc.loading"></div>
        <div class="form-group" id="enc-setup-group">
          <label data-i18n="enc.setupPassword"></label>
          <input type="password" id="enc-password" class="form-control" data-i18n-placeholder="enc.passwordPlaceholder">
          <button class="btn btn-primary" id="enc-setup-btn" data-i18n="enc.setupBtn"></button>
        </div>
        <div class="form-group" id="enc-unlock-group" style="display:none">
          <label data-i18n="enc.unlockPassword"></label>
          <input type="password" id="enc-unlock-password" class="form-control" data-i18n-placeholder="enc.unlockPasswordPlaceholder">
          <button class="btn btn-primary" id="enc-unlock-btn" data-i18n="enc.unlockBtn"></button>
        </div>
        <div class="form-group" id="enc-recovery-group" style="display:none">
          <label data-i18n="enc.recoveryCode"></label>
          <input type="text" id="enc-recovery-code" class="form-control" data-i18n-placeholder="enc.recoveryCodePlaceholder">
          <button class="btn btn-warning" id="enc-recovery-btn" data-i18n="enc.recoveryBtn"></button>
        </div>
        <div id="enc-recovery-display" style="display:none">
          <div class="alert alert-warning" data-i18n="enc.recoveryWarning"></div>
          <pre id="enc-recovery-codes"></pre>
        </div>
      </div>`;
    applyI18n(container);
    // 注：实际 keyring API 需要后端路由支持，这里预留 UI 框架
  };
})();
