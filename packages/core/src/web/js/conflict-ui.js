/**
 * T14: 冲突解决 UI — 三栏对比（base/local/remote/merged）
 * 文案经 window.t() / data-i18n 提取（zh-CN.json / en-US.json 同步维护）。
 */
(function () {
  'use strict';
  window.initConflictUI = function (container, conflict) {
    container.innerHTML = `
      <div class="conflict-ui">
        <h3>${t('conflict.title', { path: conflict.path })}</h3>
        <div class="conflict-grid">
          <div class="conflict-col"><h4 data-i18n="conflict.base"></h4><pre class="conflict-content">${conflict.base || t('conflict.none')}</pre></div>
          <div class="conflict-col"><h4 data-i18n="conflict.local"></h4><pre class="conflict-content">${conflict.local || t('conflict.none')}</pre></div>
          <div class="conflict-col"><h4 data-i18n="conflict.remote"></h4><pre class="conflict-content">${conflict.remote || t('conflict.none')}</pre></div>
        </div>
        <div class="form-group"><h4 data-i18n="conflict.merged"></h4><textarea id="conflict-merged" class="form-control" rows="10">${conflict.merged || ''}</textarea></div>
        <div class="conflict-actions">
          <button class="btn btn-primary" data-strategy="local" data-i18n="conflict.strategyLocal"></button>
          <button class="btn btn-primary" data-strategy="remote" data-i18n="conflict.strategyRemote"></button>
          <button class="btn btn-primary" data-strategy="merge" data-i18n="conflict.strategyMerge"></button>
          <button class="btn btn-success" id="conflict-save" data-i18n="conflict.save"></button>
        </div>
      </div>`;
    applyI18n(container);
    container.querySelectorAll('[data-strategy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const strategy = btn.getAttribute('data-strategy');
        const merged = document.getElementById('conflict-merged');
        if (strategy === 'local') merged.value = conflict.local || '';
        else if (strategy === 'remote') merged.value = conflict.remote || '';
        else if (strategy === 'merge' && conflict.merged) merged.value = conflict.merged;
      });
    });
  };
})();
