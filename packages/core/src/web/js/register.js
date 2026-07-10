/**
 * Doc77 Register JS — registration modal with manual + discover tabs
 */

// ═══ Modal Show/Hide ═══
window.showRegisterModal = function() {
  var modal = document.getElementById('registerModal');
  if (modal) modal.style.display = 'flex';
  // Reset to manual tab
  window.switchRegisterTab('manual');
  document.getElementById('regName').value = '';
  document.getElementById('regPath').value = '';
  document.getElementById('regError').style.display = 'none';
};

window.closeRegisterModal = function() {
  var modal = document.getElementById('registerModal');
  if (modal) modal.style.display = 'none';
};

// ═══ Tab Switching ═══
window.switchRegisterTab = function(tab) {
  // Update tab buttons
  document.querySelectorAll('#registerModal .modal-tab').forEach(function(btn) {
    if (btn.dataset.tab === tab) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update tab panels
  document.querySelectorAll('#registerModal .tab-panel').forEach(function(panel) {
    panel.classList.remove('active');
  });
  var target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');

  // If switching to discover tab, clear previous results
  if (tab === 'discover') {
    document.getElementById('discoverCandidates').innerHTML = '';
    document.getElementById('discoverStatus').textContent = '';
    document.getElementById('discoverActions').style.display = 'none';
  }
};
