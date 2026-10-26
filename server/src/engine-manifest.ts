import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeVersion,
  readInstalledManifest,
  resolveTarget,
} from '../scripts/engine-install.mjs';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 引擎安装目录（与 server/scripts/setup-engine.mjs 同一位置） */
export const engineToolDir = path.join(serverRoot, '..', 'opengrep-tool');

const catalogPath = path.join(serverRoot, 'scripts', 'engines.json');

export interface EngineAsset {
  file: string;
  sha256: string;
}

export interface EngineCatalog {
  version: string;
  baseUrl: string;
  notes?: string;
  assets: Record<string, EngineAsset>;
}

/** 本次实际要安装/使用的引擎目标（installed.json 比清单新时以本地记录为准） */
export interface EngineTarget {
  version: string;
  assetFile: string;
  sha256: string;
  source: string;
}

let catalogCache: EngineCatalog | undefined;

/** engines.json 只读且很小，进程内缓存一次即可（升级只改 installed.json） */
export function engineCatalog(): EngineCatalog {
  catalogCache ??= JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as EngineCatalog;
  return catalogCache;
}

/** 当前平台的安装目标；平台无对应资产时返回 undefined（health 不能因此 500） */
export function engineTarget(): EngineTarget | undefined {
  try {
    return resolveTarget({
      catalog: engineCatalog(),
      installed: readInstalledManifest(engineToolDir),
      platform: process.platform,
    });
  } catch {
    return undefined;
  }
}

/** 清单目标版本（去掉前缀 v，供界面展示） */
export function engineTargetVersion(): string | undefined {
  const target = engineTarget();
  return target ? normalizeVersion(target.version) : undefined;
}
