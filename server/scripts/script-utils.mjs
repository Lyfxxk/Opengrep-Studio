import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackTempDir(dir);
  return dir;
}

export function useTempDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;
  process.env.CUSTOM_RULES_DIR = path.join(dir, 'rules-custom');
  return dir;
}

export function isBackendUnreachable(error) {
  let cause = error;
  while (cause) {
    if (cause.code === 'ECONNREFUSED' || cause.code === 'ENOTFOUND' || cause.code === 'ECONNRESET') return true;
    if (Array.isArray(cause.errors) && cause.errors.some((item) => item?.code === 'ECONNREFUSED')) return true;
    cause = cause.cause;
  }
  return false;
}
