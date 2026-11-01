import fs from 'node:fs';

export function trackTempDir(dir, closeDatabase) {
  process.on('exit', () => {
    try {
      closeDatabase?.();
    } catch {
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  });
}
