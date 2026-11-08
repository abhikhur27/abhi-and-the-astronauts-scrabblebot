import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModel } from '../src/model.js';

test('live entry refuses to create an anonymous client when credentials are missing', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/live.ts', '--check'], {
    encoding: 'utf8', env: { ...process.env, BOT_TOKEN_FILE: '', BOT_KIND: 'math' }, timeout: 15_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /token file is required/);
});
test('live learner rejects a checkpoint trained against another dictionary', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hackutd-mismatch-'));
  try {
    const tokenFile = join(folder, 'token.txt');
    const modelFile = join(folder, 'model.json');
    writeFileSync(tokenFile, 'disposable-test-marker');
    writeFileSync(modelFile, JSON.stringify({ ...createModel(), dictionaryHash: 'wrong-dictionary' }));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/live.ts', '--check'], {
      encoding: 'utf8', env: { ...process.env, BOT_TOKEN_FILE: tokenFile, BOT_KIND: 'learner', MODEL_PATH: modelFile }, timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dictionary hash mismatch/);
  } finally { rmSync(folder, { recursive: true }); }
});
test('offline configuration check loads actual SDK bindings and dictionary without printing the token', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hackutd-live-'));
  const tokenFile = join(folder, 'token.txt');
  const token = 'disposable-test-marker-never-a-real-credential';
  writeFileSync(tokenFile, token);
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/live.ts', '--check'], {
      encoding: 'utf8', env: { ...process.env, BOT_TOKEN_FILE: tokenFile, BOT_KIND: 'math' }, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.networkStarted, false);
    assert.ok(report.dictionaryWords > 170_000);
    assert.equal((result.stdout + result.stderr).includes(token), false);
  } finally { rmSync(folder, { recursive: true }); }
});
