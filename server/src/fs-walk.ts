import fs from 'node:fs';
import path from 'node:path';

export const ALWAYS_SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

interface WalkResult {
  files: number;
  bytes: number;
}

export function walkAndStripSymlinks(dir: string): WalkResult {
  let files = 0;
  let bytes = 0;
  const symlinks: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  for (const link of symlinks) fs.rmSync(link, { force: true });
  return { files, bytes };
}
