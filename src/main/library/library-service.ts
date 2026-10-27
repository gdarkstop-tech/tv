import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryRoot, MediaKind, ScanStatus } from '../../shared/types';
import type { NovaDatabase } from '../db';
import { locateTool } from '../hardware/tools';
import { logger } from '../log';
import { dataPaths } from '../paths';
import type { SettingsStore } from '../settings-store';
import { audioTagsFromPath, cleanTitle, kindForFile } from './naming';
import { makeThumbnail, probeFile } from './probe';

const log = logger('library');

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '.trash', '.trashes', '@eadir', 'windows', 'program files', 'program files (x86)', 'programdata', 'appdata']);
const MAX_FILES_PER_ROOT = 200_000;
const MAX_DEPTH = 16;

export function mediaIdFor(filePath: string): string {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 24);
}

/** Paths a user must not add as a library folder (whole drives / system folders). */
export function isForbiddenRoot(p: string): boolean {
  const resolved = path.resolve(p);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    // A dedicated media drive (e.g. D:\) is fine; the system drive is not.
    if (process.platform !== 'win32') return true;
    const systemDrive = (process.env.SystemDrive ?? 'C:').toLowerCase();
    return parsed.root.toLowerCase().startsWith(systemDrive);
  }
  const lower = resolved.toLowerCase();
  const sys = process.platform === 'win32'
    ? [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']
    : ['/etc', '/bin', '/sbin', '/usr', '/proc', '/sys', '/dev', '/boot', '/lib', '/var', '/System', '/Library'];
  return sys.some((s) => lower === s.toLowerCase() || lower.startsWith(s.toLowerCase() + path.sep));
}

export class LibraryService extends EventEmitter {
  private status: ScanStatus = { running: false, scanned: 0, added: 0, removed: 0, probing: 0, lastScanAt: null, errors: [] };
  private probeRunning = false;
  private scanQueued = false;

  constructor(
    private readonly db: NovaDatabase,
    private readonly settings: SettingsStore,
  ) {
    super();
  }

  scanStatus(): ScanStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  roots(): LibraryRoot[] {
    return this.db.roots().map((r) => ({ ...r, available: fs.existsSync(r.path) }));
  }

  addRoot(dir: string, kind: MediaKind): LibraryRoot {
    const resolved = path.resolve(dir);
    let st: fs.Stats;
    try {
      st = fs.statSync(resolved);
    } catch {
      throw new Error('That folder does not exist.');
    }
    if (!st.isDirectory()) throw new Error('Please choose a folder, not a file.');
    if (isForbiddenRoot(resolved)) throw new Error('Choose a specific media folder rather than a whole drive or a system folder.');
    const root = this.db.addRoot(resolved, kind);
    this.db.logEvent('library', `added ${kind} folder`);
    void this.scan();
    return root;
  }

  removeRoot(id: number): void {
    this.db.removeRoot(id);
    this.emit('changed');
  }

  /** Is this absolute path inside a registered library root of the given kind? */
  isInsideRoot(filePath: string, kind?: MediaKind): boolean {
    const resolved = path.resolve(filePath);
    return this.db.roots(kind).some((r) => {
      const rel = path.relative(r.path, resolved);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  async scan(): Promise<ScanStatus> {
    if (this.status.running) {
      this.scanQueued = true;
      return this.scanStatus();
    }
    this.status = { running: true, scanned: 0, added: 0, removed: 0, probing: 0, lastScanAt: this.status.lastScanAt, errors: [] };
    this.emit('scan', this.scanStatus());
    try {
      for (const root of this.db.roots()) await this.scanRoot(root);
    } catch (err) {
      this.status.errors.push(String(err));
    } finally {
      this.status.running = false;
      this.status.lastScanAt = Date.now();
      this.emit('scan', this.scanStatus());
      this.emit('changed');
    }
    void this.processProbes();
    if (this.scanQueued) {
      this.scanQueued = false;
      return this.scan();
    }
    return this.scanStatus();
  }

  private async scanRoot(root: LibraryRoot): Promise<void> {
    if (!fs.existsSync(root.path)) {
      this.status.errors.push(`Folder not available: ${root.path}`);
      return; // keep entries: the drive may simply be disconnected
    }
    const known = this.db.mediaPathsForRoot(root.id);
    const seen = new Set<string>();
    let count = 0;
    let batch: Array<() => void> = [];
    const flush = () => {
      if (!batch.length) return;
      const ops = batch;
      batch = [];
      this.db.transaction(() => ops.forEach((op) => op()));
    };

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || count > MAX_FILES_PER_ROOT) return;
      let handle: fs.Dir;
      try {
        handle = await fs.promises.opendir(dir);
      } catch (err) {
        if (this.status.errors.length < 20) this.status.errors.push(`Cannot read ${dir}: ${(err as Error).message}`);
        return;
      }
      for await (const entry of handle) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue; // ignore symlinks to avoid escaping the root
        const kind = kindForFile(entry.name);
        if (kind !== root.kind) continue;
        count++;
        this.status.scanned++;
        seen.add(full);
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
        const prev = known.get(full);
        const mtime = Math.floor(st.mtimeMs);
        if (prev && prev.size === st.size && prev.mtime === mtime) continue;
        if (!prev) this.status.added++;
        const tags = kind === 'audio' ? audioTagsFromPath(full, root.path) : null;
        const item = {
          id: mediaIdFor(full),
          rootId: root.id,
          path: full,
          kind,
          title: tags ? tags.title : kind === 'photo' ? entry.name.replace(/\.[^.]+$/, '') : cleanTitle(entry.name),
          fileName: entry.name,
          size: st.size,
          mtime,
          artist: tags?.artist ?? null,
          album: tags?.album ?? null,
        };
        batch.push(() => this.db.upsertMedia(item));
        if (batch.length >= 200) {
          flush();
          this.emit('scan', this.scanStatus());
          await new Promise((r) => setImmediate(r));
        }
      }
    };
    await walk(root.path, 0);
    flush();
    const removed = [...known.entries()].filter(([p]) => !seen.has(p)).map(([, v]) => v.id);
    if (removed.length) {
      this.db.transaction(() => this.db.deleteMedia(removed));
      this.status.removed += removed.length;
    }
    log.info('scanned root', { kind: root.kind, files: count, removed: removed.length });
  }

  /** Background metadata probing and thumbnail generation (one file at a time). */
  async processProbes(): Promise<void> {
    if (this.probeRunning) return;
    this.probeRunning = true;
    const s = this.settings.get();
    const tools = {
      ffprobe: locateTool('ffprobe', s.tools.ffprobePath),
      ffmpeg: locateTool('ffmpeg'),
      mpv: locateTool('mpv', s.tools.mpvPath),
    };
    try {
      for (;;) {
        const rows = this.db.unprobed(10);
        if (!rows.length) break;
        for (const row of rows) {
          this.status.probing = rows.length;
          const r = await probeFile(row.path, tools).catch(() => null);
          if (r) {
            this.db.updateProbe(row.id, {
              ...r,
              title: row.kind === 'audio' ? r.title : null,
              artist: row.kind === 'audio' ? r.artist : null,
              album: row.kind === 'audio' ? r.album : null,
            });
          } else this.db.markProbeFailed(row.id);
        }
        this.emit('changed');
      }
      for (;;) {
        const rows = this.db.needingThumb(5);
        if (!rows.length) break;
        for (const row of rows) {
          const out = path.join(dataPaths.thumbnails(), `${row.id}.jpg`);
          const ok = await makeThumbnail(row.path, out, row.duration, tools).catch(() => false);
          this.db.setThumb(row.id, ok ? out : '');
        }
        this.emit('changed');
      }
    } finally {
      this.status.probing = 0;
      this.probeRunning = false;
    }
  }
}
