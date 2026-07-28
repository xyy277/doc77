/**
 * AI Skill Library — right drawer of the workspace.
 *
 * Renders the list of skills (built-in / project / user) with enable/disable
 * switches and a reload button. Skills are fetched from GET /api/ai/skills
 * and toggled via POST /api/ai/skills/:id/{enable,disable}.
 *
 * Skills marked `alwaysApply` show a badge — these are injected into every
 * system prompt automatically (progressive disclosure layer 0). Other
 * skills are available to the LLM via the `Skill` meta-tool.
 */
(function () {
  'use strict';

  var BODY = null;
  var currentSkills = [];
  var available = false;

  function init() {
    BODY = document.getElementById('aiSkillBody');
    if (!BODY) return;
    refresh();
  }

  function refresh() {
    if (!BODY) return;
    fetch('/api/ai/skills')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        available = !!data.available;
        currentSkills = (data && data.skills) || [];
        render();
      })
      .catch(function () {
        available = false;
        currentSkills = [];
        render();
      });
  }

  function groupBySource(skills) {
    var groups = { builtin: [], project: [], user: [] };
    for (var i = 0; i < skills.length; i++) {
      var s = skills[i];
      var src = s.source || 'builtin';
      if (!groups[src]) groups[src] = [];
      groups[src].push(s);
    }
    return groups;
  }

  function sourceLabel(key) {
    return {
      builtin: t('web.ai.skills.group.builtin'),
      project: t('web.ai.skills.group.project'),
      user: t('web.ai.skills.group.user'),
    }[key] || key;
  }

  function render() {
    if (!BODY) return;
    if (!available) {
      BODY.innerHTML = '<div class="ai-empty-list">' + esc(t('web.ai.skills.empty')) + '</div>';
      return;
    }
    if (!currentSkills.length) {
      BODY.innerHTML = '<div class="ai-empty-list">' + esc(t('web.ai.skills.empty')) + '</div>';
      return;
    }
    var groups = groupBySource(currentSkills);
    var order = ['builtin', 'project', 'user'];
    var html = '<div style="padding:4px 6px 10px"><button class="ai-msg-action-btn" onclick="aiSkillLibrary.reload()" style="width:100%;padding:6px">🔄 ' + esc(t('web.ai.skills.reload')) + '</button></div>';
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var items = groups[key];
      if (!items || !items.length) continue;
      html += '<div class="ai-skill-group">';
      html += '<div class="ai-skill-group-title">' + esc(sourceLabel(key)) + '</div>';
      for (var j = 0; j < items.length; j++) {
        html += renderCard(items[j]);
      }
      html += '</div>';
    }
    BODY.innerHTML = html;

    // Wire up switches
    BODY.querySelectorAll('.ai-switch input').forEach(function (input) {
      input.addEventListener('change', function () {
        var name = input.dataset.name;
        var enabled = input.checked;
        toggleSkill(name, enabled);
      });
    });
  }

  function renderCard(s) {
    var name = s.name || 'unnamed';
    var desc = s.description || '';
    var source = s.source || 'builtin';
    var enabled = !!s.enabled;
    var alwaysApply = !!s.alwaysApply;

    var html = '<div class="ai-skill-card" data-skill="' + escAttr(name) + '">';
    html += '<div class="ai-skill-card-top">';
    html += '<div><div class="sk-name">' + esc(name) + '</div>';
    if (alwaysApply) html += '<span class="sk-badge ' + source + '">' + esc(t('web.ai.skills.alwaysApply')) + '</span> ';
    html += '<span class="sk-badge ' + source + '">' + esc(source) + '</span></div>';
    html += '<label class="ai-switch"><input type="checkbox" data-name="' + escAttr(name) + '"' + (enabled ? ' checked' : '') + '><span class="slider"></span></label>';
    html += '</div>';
    if (desc) html += '<div class="sk-desc">' + esc(desc) + '</div>';
    html += '</div>';
    return html;
  }

  function toggleSkill(name, enabled) {
    var url = '/api/ai/skills/' + encodeURIComponent(name) + '/' + (enabled ? 'enable' : 'disable');
    fetch(url, { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('toggle failed');
        return r.json();
      })
      .then(function () {
        // Update local state so the switch stays in sync without a full reload
        for (var i = 0; i < currentSkills.length; i++) {
          if (currentSkills[i].name === name) currentSkills[i].enabled = enabled;
        }
      })
      .catch(function () {
        toast('Error', 'error');
        refresh(); // revert on failure
      });
  }

  function reload() {
    fetch('/api/ai/skills/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        toast(t('web.ai.skills.reloaded'), 'success');
        currentSkills = (data && data.skills) || [];
        render();
      })
      .catch(function () { toast('Error', 'error'); });
  }

  document.addEventListener('DOMContentLoaded', init);

  window.aiSkillLibrary = {
    init: init,
    refresh: refresh,
    reload: reload,
  };
})();
