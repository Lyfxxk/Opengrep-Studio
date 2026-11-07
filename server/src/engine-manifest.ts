import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeVersion,
  readInstalledManifest,
  resolveTarget,
} from '../scripts/engine-install.mjs';
import { serverRoot } from './config.js';

export const engineToolDir = path.join(serverRoot, '..', 'opengrep-tool');

const catalogPath = path.join(serverRoot, 'scripts', 'engines.json');

export interface EngineAsset {
  file: string;
  sha256: string;
}

export interface EngineCatalog {
  version: string;
  notes?: string;
  assets: Record<string, EngineAsset>;
}

export interface EngineTarget {
  version: string;
  assetFile: string;
  sha256: string;
  source: string;
}

let catalogCache: EngineCatalog | undefined;

function engineCatalog(): EngineCatalog {
  catalogCache ??= JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as EngineCatalog;
  return catalogCache;
}

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

export function engineTargetVersion(): string | undefined {
  const target = engineTarget();
  return target ? normalizeVersion(target.version) : undefined;
}
