import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const waitWord = new Int32Array(new SharedArrayBuffer(4));
let sequence = 0;

/** Replace complete JSON, tolerating brief Windows reader/antivirus locks. */
export function atomicWriteJson(path: string, value: unknown, maximumWaitMs = 1000): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${++sequence}`;
  const deadline = Date.now() + maximumWaitMs;
  let delay = 2;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
    for (;;) {
      try { renameSync(temporary, path); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) throw error;
        Atomics.wait(waitWord, 0, 0, Math.min(delay, Math.max(1, deadline - Date.now())));
        delay = Math.min(32, delay * 2);
      }
    }
  } finally {
    // Best-effort cleanup must not replace the original write/rename error.
    try { unlinkSync(temporary); } catch { /* Destination and original failure are preserved. */ }
  }
}
