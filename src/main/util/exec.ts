import { execFile, type ExecFileOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// All external programs are started with execFile/spawn and an argument
// array — never through a shell — so no user or remote input can be
// interpreted as shell syntax.

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timedOut: boolean;
}

export function run(file: string, args: string[], opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const options: ExecFileOptions = {
      timeout: opts.timeoutMs ?? 15000,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    };
    execFile(file, args, options, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: err ? err.message : null,
        timedOut: Boolean(err?.killed && err.signal === 'SIGTERM'),
      });
    });
  });
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate an executable on PATH (and optional extra directories). */
export function which(name: string, extraDirs: string[] = []): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  const hasExt = process.platform === 'win32' && /\.[a-z0-9]+$/i.test(name);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      // Never resolve .bat/.cmd: they would require a shell to run.
      if (ext === '.bat' || ext === '.cmd') continue;
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function fileExists(p: string | null | undefined): p is string {
  return Boolean(p) && isExecutable(p as string);
}
