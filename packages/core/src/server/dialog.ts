import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Detect WSL by checking /proc/version.
 */
function isWSL(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch { return false; }
}

/**
 * Detect if we have a graphical display (X11 or Wayland).
 */
function hasDisplay(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Open a native OS directory picker dialog.
 * Returns the selected directory path, or null if cancelled / unavailable.
 */
export function openDirectoryDialog(): Promise<string | null> {
  if (isWSL()) {
    // WSL: try Windows interop first, then X11 fallbacks
    return wslDialog();
  }

  const platform = process.platform;
  if (platform === 'linux') return linuxDialog();
  if (platform === 'darwin') return macDialog();
  if (platform === 'win32') return winDialog();

  return Promise.resolve(null);
}

// ══════════ WSL ══════════

async function wslDialog(): Promise<string | null> {
  // Strategy A: Try Windows interop (works when WSL binfmt is configured)
  const winPath = await tryWindowsInterop();
  if (winPath) {
    return winToWsl(winPath);
  }

  // Strategy B: Try Linux GUI tools (works when X11 forwarding is set up)
  if (hasDisplay()) {
    return linuxDialog();
  }

  // Strategy C: Neither Windows interop nor X11 — return null
  // Frontend should fall back to browser's webkitdirectory picker
  return null;
}

async function tryWindowsInterop(): Promise<string | null> {
  // Try different methods to invoke PowerShell from WSL
  const methods: Array<() => Promise<string | null>> = [
    () => runPowershell('powershell.exe'),
    () => runViaCmd(),
  ];

  for (const method of methods) {
    const result = await method();
    if (result) return result;
  }
  return null;
}

function runPowershell(exePath: string): Promise<string | null> {
  const psScript = `Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Select project directory';$d.ShowNewFolderButton=1;if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.SelectedPath}`;
  return new Promise((resolve) => {
    execFile(exePath, ['-NoProfile', '-Command', psScript], { timeout: 120000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}

function runViaCmd(): Promise<string | null> {
  return new Promise((resolve) => {
    const psScript = `Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Select project directory';if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.SelectedPath}`;
    execFile('cmd.exe', ['/c', 'powershell.exe', '-NoProfile', '-Command', psScript], { timeout: 120000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}

function winToWsl(winPath: string): string | null {
  return new Promise((resolve) => {
    execFile('wslpath', ['-u', winPath], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        // Manual fallback: C:\foo\bar → /mnt/c/foo/bar
        const match = winPath.match(/^([A-Z]):\\(.*)$/i);
        if (match) {
          resolve(`/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`);
        } else {
          resolve(null);
        }
      }
      resolve(stdout.trim());
    });
  });
}

// ══════════ Linux ══════════

function linuxDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    // Try zenity first
    execFile('zenity', ['--file-selection', '--directory', '--title=选择项目目录'], { timeout: 120000 }, (err, stdout) => {
      if (!err && stdout) { resolve(stdout.trim()); return; }
      // Fallback to kdialog
      execFile('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], { timeout: 120000 }, (err2, stdout2) => {
        if (!err2 && stdout2) { resolve(stdout2.trim()); return; }
        // Fallback to yad
        execFile('yad', ['--file-selection', '--directory', '--title=选择项目目录'], { timeout: 120000 }, (err3, stdout3) => {
          if (!err3 && stdout3) { resolve(stdout3.trim()); return; }
          // Fallback to python3 tkinter
          tryTkDialog().then(resolve);
        });
      });
    });
  });
}

function tryTkDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const pyScript = 'import tkinter.filedialog as fd, tkinter as tk; root=tk.Tk(); root.withdraw(); print(fd.askdirectory(title="选择项目目录") or "")';
    execFile('python3', ['-c', pyScript], { timeout: 120000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}

// ══════════ macOS ══════════

function macDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'], { timeout: 120000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      resolve(stdout.trim());
    });
  });
}

// ══════════ Windows ══════════

function winDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const psScript = `Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='选择项目目录';$d.ShowNewFolderButton=1;if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.SelectedPath}`;
    execFile('powershell', ['-NoProfile', '-Command', psScript], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const s = stdout.trim();
      resolve(s || null);
    });
  });
}
