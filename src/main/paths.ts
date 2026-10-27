import fs from 'node:fs';
import path from 'node:path';

// Resolves application paths in development and packaged builds. Kept free of
// a hard Electron import so the module can be used by unit tests.

let resourcesRootOverride: string | null = null;
let userDataOverride: string | null = null;

function electronApp(): { isPackaged: boolean; getPath(name: string): string; getAppPath(): string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    return typeof electron === 'object' && electron.app ? electron.app : null;
  } catch {
    return null;
  }
}

export function setResourcesRoot(dir: string): void {
  resourcesRootOverride = dir;
}

export function setUserDataDir(dir: string): void {
  userDataOverride = dir;
}

/** Directory containing shaders/, windows/, test-media/ … */
export function resourcesRoot(): string {
  if (resourcesRootOverride) return resourcesRootOverride;
  const app = electronApp();
  if (app?.isPackaged) return path.join(process.resourcesPath, 'resources');
  // dev: dist/main/main.cjs → repo/resources
  const candidates = [
    path.resolve(__dirname, '../../resources'),
    path.resolve(__dirname, '../resources'),
    path.resolve(process.cwd(), 'resources'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'shaders'))) ?? candidates[0]!;
}

export function resourcePath(...parts: string[]): string {
  return path.join(resourcesRoot(), ...parts);
}

/** Root of the built app (dist/), containing renderer/ and remote/. */
export function distRoot(): string {
  const app = electronApp();
  if (app) return path.join(app.getAppPath(), 'dist');
  return path.resolve(__dirname, '..');
}

export function userDataDir(): string {
  if (userDataOverride) return userDataOverride;
  const app = electronApp();
  if (app) return app.getPath('userData');
  return path.join(process.cwd(), '.nova-dev');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dataPaths = {
  database: () => path.join(ensureDir(userDataDir()), 'nova.db'),
  logs: () => ensureDir(path.join(userDataDir(), 'logs')),
  thumbnails: () => ensureDir(path.join(userDataDir(), 'thumbnails')),
  reports: () => ensureDir(path.join(userDataDir(), 'reports')),
  runtime: () => ensureDir(path.join(userDataDir(), 'runtime')),
  cache: () => ensureDir(path.join(userDataDir(), 'cache')),
};

/** Optional bundled third-party binaries (e.g. vendor/mpv/mpv.exe in packaged builds). */
export function vendorDir(): string {
  const app = electronApp();
  if (app?.isPackaged) return path.join(process.resourcesPath, 'vendor');
  return path.resolve(resourcesRoot(), '../vendor');
}
