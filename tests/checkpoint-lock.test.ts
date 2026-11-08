import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createModel, saveModel, loadModel } from '../src/model.js';

test('checkpoint replacement survives a temporary Windows reader without delete sharing', { skip: process.platform !== 'win32' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'hackutd-lock-'));
  const path = join(folder, 'model.json');
  const ready = join(folder, 'ready');
  const script = join(folder, 'hold.ps1');
  const model = createModel();
  saveModel(path, model);
  writeFileSync(script, `param([string]$Target,[string]$Ready)\n$stream=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)\ntry { [IO.File]::WriteAllText($Ready,'ready'); Start-Sleep -Milliseconds 300 } finally { $stream.Dispose() }\n`);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Target', path, '-Ready', ready], { windowsHide: true, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(existsSync(ready), 'real Windows reader did not acquire its file lock');
    model.trainedGames = 1;
    saveModel(path, model);
    assert.equal(loadModel(path).trainedGames, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).trainedGames, 1);
  } finally {
    if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
    const target = resolve(folder);
    if (dirnameSafe(target)) rmSync(target, { recursive: true, force: true });
  }
});
function dirnameSafe(path: string): boolean {
  return resolve(path, '..') === resolve(tmpdir()) && basename(path).startsWith('hackutd-lock-');
}
