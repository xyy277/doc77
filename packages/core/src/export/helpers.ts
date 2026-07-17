import * as os from 'node:os';

/**
 * Get the local LAN IP address (non-loopback IPv4).
 */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Render a share error page (expired/invalid token).
 */
export function renderShareError(message: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Doc77 — 分享</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#1e293b}.card{text-align:center;padding:3rem}.error-icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.25rem;font-weight:600;color:#64748b}p{font-size:.875rem;color:#94a3b8}</style></head>
<body><div class="card"><div class="error-icon">🔗</div><h1>${escapeHtml(message)}</h1><p>请联系分享者重新获取链接</p></div></body></html>`;
}

/**
 * Render the share page shell.
 */
export function renderSharePage(token: { documentTitle: string; theme: string }): string {
  return `<!DOCTYPE html>
<html lang="zh" class="${token.theme === 'dark' ? 'dark' : ''}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(token.documentTitle)} — Doc77</title>
<style>
:root{--bg-body:#f8fafc;--bg-code:#f1f5f9;--text-primary:#1e293b;--text-secondary:#64748b;--border-light:#e2e8f0;--accent:#6366f1}.dark{--bg-body:#0f172a;--bg-code:#1e293b;--text-primary:#e2e8f0;--text-secondary:#94a3b8;--border-light:#334155;--accent:#818cf8}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg-body);color:var(--text-primary);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.6}
.doc77-share-page{min-height:100vh;display:flex;flex-direction:column}
.doc77-share-header{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1.5rem;border-bottom:1px solid var(--border-light);background:var(--bg-body);position:sticky;top:0;z-index:10}
.doc77-share-header .brand{font-weight:700;font-size:.875rem;color:var(--accent);text-decoration:none}
.doc77-share-header .info{font-size:.75rem;color:var(--text-secondary)}
.doc77-content{padding:2rem;max-width:56rem;width:100%;margin:0 auto}
.doc77-share-footer{text-align:center;padding:1rem;font-size:.75rem;color:var(--text-secondary);border-top:1px solid var(--border-light);margin-top:auto}
.doc77-share-footer a{color:var(--accent);text-decoration:none}
.loading{text-align:center;padding:4rem 0;color:var(--text-secondary)}
.doc-content h1{font-size:1.875rem;font-weight:700;padding-bottom:.75rem;margin-bottom:1.5rem;border-bottom:1px solid var(--border-light)}
.doc-content h2{font-size:1.25rem;font-weight:600;margin-top:2rem;margin-bottom:1rem}
.doc-content p{margin-bottom:1rem;line-height:1.75}
.doc-content code{background:var(--bg-code);padding:.125rem .375rem;border-radius:.25rem;font-size:.875em}
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljsTheme" crossorigin="anonymous">
</head>
<body>
<div class="doc77-share-page">
  <header class="doc77-share-header">
    <a href="https://doc77.dev" class="brand" target="_blank" rel="noopener">Doc77</a>
    <span class="info">只读分享 · 通过 Doc77 分享</span>
  </header>
  <div class="doc77-content" id="content">
    <div class="loading">加载中...</div>
  </div>
  <footer class="doc77-share-footer">
    Powered by <a href="https://doc77.dev" target="_blank" rel="noopener">Doc77</a>
  </footer>
</div>
<script>
fetch('/api/share/' + window.location.pathname.split('/').pop() + '/data')
  .then(function(r){ if(!r.ok) throw new Error('not found'); return r.json(); })
  .then(function(d){
    var c = document.getElementById('content');
    if(d.theme === 'dark') document.documentElement.classList.add('dark');
    document.title = d.title + ' — Doc77';
    if(d.type === 'image') {
      c.innerHTML = '<div style="text-align:center"><img src="' + d.rawUrl + '" alt="" style="max-width:100%;max-height:90vh;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1)"></div>';
    } else if(d.type === 'pdf') {
      c.innerHTML = '<iframe src="' + d.rawUrl + '" style="width:100%;height:90vh;border:none;border-radius:8px"></iframe>';
    } else {
      c.innerHTML = '<article class="doc-content">' + d.content + '</article>';
    }
    document.title = d.title + ' — Doc77';
    // Re-highlight code blocks
    if(typeof hljs !== 'undefined') { document.querySelectorAll('pre code').forEach(function(b){ hljs.highlightElement(b); }); }
  })
  .catch(function(){
    document.getElementById('content').innerHTML = '<div class="loading">此链接已过期或无效</div>';
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
