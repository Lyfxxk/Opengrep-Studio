import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 <repo>/server/scripts/，向上两级取仓库根
const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const subPkgs = ['code', 'server'];

const { version } = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const changed = [];

for (const dir of subPkgs) {
  const pkgFile = path.join(rootDir, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (pkg.version === version) continue;
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

  const lockFile = path.join(rootDir, dir, 'package-lock.json');
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  }
  changed.push(dir);
}

if (changed.length > 0) console.log(`[sync-version] ${changed.join(', ')} → ${version}`);
else console.log(`[sync-version] 各包版本已一致（${version}）`);

if (existsSync(path.join(rootDir, '.git'))) {
  try {
    execSync(
      subPkgs.map((d) => `git add ${d}/package.json ${d}/package-lock.json`).join(' && '),
      { cwd: rootDir, stdio: 'pipe' },
    );
  } catch {
  }
}
