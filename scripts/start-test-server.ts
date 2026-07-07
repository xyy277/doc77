import { initDatabase } from '../packages/core/src/db/connection.js';
import { runMigrations } from '../packages/core/src/db/migrations.js';
import { registerProject } from '../packages/core/src/db/projects.js';
import { loadDefaults } from '../packages/core/src/db/config.js';
import { createApp } from '../packages/core/src/server/app.js';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const testDir = path.join(os.tmpdir(), 'doc77-e2e-test');
fs.mkdirSync(testDir, { recursive: true });

// Initialize database
const dbPath = path.join(os.homedir(), '.doc77', 'data.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
initDatabase(dbPath);
runMigrations();
loadDefaults();

// Create test project
const projDir = path.join(testDir, 'demo-project');
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, 'README.md'), `# Hello Doc77\n\nThis is a **test** project.\n\n## Features\n\n- Markdown preview\n- File tree navigation\n- Code highlighting`);
fs.writeFileSync(path.join(projDir, 'config.json'), JSON.stringify({ version: '1.0', debug: false }, null, 2));
const docsDir = path.join(projDir, 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir);
}
fs.writeFileSync(path.join(projDir, 'docs', 'guide.md'), '## User Guide\n\nWelcome to Doc77!');

// Register project (skip if already exists)
try {
  registerProject('Demo 项目', projDir);
} catch {
  // Already exists
}

const PORT = 3099;
const app = createApp();
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
});
