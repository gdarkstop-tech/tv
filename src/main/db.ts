import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { LibraryRoot, MediaItem, MediaKind, WatchHistory } from '../shared/types';

// Local SQLite store (node:sqlite, built into Electron's Node runtime — no
// native module to rebuild). Holds settings, library index, watch history,
// paired remote devices and a small security/audit event log.

const MIGRATIONS: string[] = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE library_roots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     path TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('video','audio','photo')),
     added_at INTEGER NOT NULL,
     UNIQUE(path, kind)
   );
   CREATE TABLE media (
     id TEXT PRIMARY KEY,
     root_id INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
     path TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     file_name TEXT NOT NULL,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     added_at INTEGER NOT NULL,
     duration REAL, width INTEGER, height INTEGER,
     video_codec TEXT, audio_codec TEXT, fps REAL, hdr TEXT,
     artist TEXT, album TEXT,
     thumb TEXT,
     probed INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX media_kind ON media(kind, title);
   CREATE INDEX media_root ON media(root_id);
   CREATE TABLE history (
     media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
     position REAL NOT NULL DEFAULT 0,
     duration REAL NOT NULL DEFAULT 0,
     watched INTEGER NOT NULL DEFAULT 0,
     last_played_at INTEGER NOT NULL,
     play_count INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX history_recent ON history(last_played_at DESC);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     secret TEXT NOT NULL,
     secret_protected INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL
   );`,
];

export interface MediaRow {
  id: string;
  root_id: number;
  path: string;
  kind: MediaKind;
  title: string;
  file_name: string;
  size: number;
  mtime: number;
  added_at: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  fps: number | null;
  hdr: string | null;
  artist: string | null;
  album: string | null;
  thumb: string | null;
  probed: number;
  h_position?: number | null;
  h_duration?: number | null;
  h_watched?: number | null;
  h_last?: number | null;
  h_count?: number | null;
}

export interface DeviceRow {
  id: string;
  name: string;
  secret: string;
  secret_protected: number;
  created_at: number;
  last_seen_at: number | null;
}

export function rowToMedia(r: MediaRow): MediaItem {
  const history: WatchHistory | null =
    r.h_last !== null && r.h_last !== undefined
      ? {
          position: r.h_position ?? 0,
          duration: r.h_duration ?? 0,
          watched: Boolean(r.h_watched),
          lastPlayedAt: r.h_last,
          playCount: r.h_count ?? 0,
        }
      : null;
  return {
    id: r.id,
    rootId: r.root_id,
    kind: r.kind,
    title: r.title,
    fileName: r.file_name,
    size: r.size,
    mtime: r.mtime,
    addedAt: r.added_at,
    duration: r.duration,
    width: r.width,
    height: r.height,
    videoCodec: r.video_codec,
    audioCodec: r.audio_codec,
    fps: r.fps,
    hdr: r.hdr,
    artist: r.artist,
    album: r.album,
    hasThumbnail: Boolean(r.thumb),
    probed: Boolean(r.probed),
    history,
  };
}

const MEDIA_SELECT = `SELECT m.*, h.position AS h_position, h.duration AS h_duration, h.watched AS h_watched,
  h.last_played_at AS h_last, h.play_count AS h_count FROM media m LEFT JOIN history h ON h.media_id = m.id`;

export class NovaDatabase {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
    let v = row?.v ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
    while (v < MIGRATIONS.length) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
      });
      v++;
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- kv ----
  kvGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- library roots ----
  roots(kind?: MediaKind): LibraryRoot[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM library_roots WHERE kind = ? ORDER BY path').all(kind)
      : this.db.prepare('SELECT * FROM library_roots ORDER BY kind, path').all()) as Array<{ id: number; path: string; kind: MediaKind; added_at: number }>;
    return rows.map((r) => ({ id: r.id, path: r.path, kind: r.kind, addedAt: r.added_at, available: true }));
  }

  addRoot(path: string, kind: MediaKind): LibraryRoot {
    this.db.prepare('INSERT OR IGNORE INTO library_roots (path, kind, added_at) VALUES (?, ?, ?)').run(path, kind, Date.now());
    const r = this.db.prepare('SELECT * FROM library_roots WHERE path = ? AND kind = ?').get(path, kind) as { id: number; path: string; kind: MediaKind; added_at: number };
    return { id: r.id, path: r.path, kind: r.kind, addedAt: r.added_at, available: true };
  }

  removeRoot(id: number): void {
    this.db.prepare('DELETE FROM library_roots WHERE id = ?').run(id);
  }

  // ---- media ----
  mediaPathsForRoot(rootId: number): Map<string, { id: string; size: number; mtime: number }> {
    const rows = this.db.prepare('SELECT id, path, size, mtime FROM media WHERE root_id = ?').all(rootId) as Array<{ id: string; path: string; size: number; mtime: number }>;
    return new Map(rows.map((r) => [r.path, { id: r.id, size: r.size, mtime: r.mtime }]));
  }

  upsertMedia(m: { id: string; rootId: number; path: string; kind: MediaKind; title: string; fileName: string; size: number; mtime: number; artist?: string | null; album?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO media (id, root_id, path, kind, title, file_name, size, mtime, added_at, artist, album)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, probed = CASE WHEN media.mtime = excluded.mtime THEN media.probed ELSE 0 END`,
      )
      .run(m.id, m.rootId, m.path, m.kind, m.title, m.fileName, m.size, m.mtime, Date.now(), m.artist ?? null, m.album ?? null);
  }

  deleteMedia(ids: string[]): void {
    const stmt = this.db.prepare('DELETE FROM media WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  updateProbe(id: string, p: { duration: number | null; width: number | null; height: number | null; videoCodec: string | null; audioCodec: string | null; fps: number | null; hdr: string | null; title?: string | null; artist?: string | null; album?: string | null }): void {
    this.db
      .prepare(
        `UPDATE media SET duration = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?, fps = ?, hdr = ?,
         title = COALESCE(?, title), artist = COALESCE(?, artist), album = COALESCE(?, album), probed = 1 WHERE id = ?`,
      )
      .run(p.duration, p.width, p.height, p.videoCodec, p.audioCodec, p.fps, p.hdr, p.title ?? null, p.artist ?? null, p.album ?? null, id);
  }

  markProbeFailed(id: string): void {
    this.db.prepare('UPDATE media SET probed = 2 WHERE id = ?').run(id);
  }

  setThumb(id: string, thumb: string | null): void {
    this.db.prepare('UPDATE media SET thumb = ? WHERE id = ?').run(thumb, id);
  }

  unprobed(limit: number): MediaRow[] {
    return this.db.prepare('SELECT * FROM media WHERE probed = 0 AND kind != ? ORDER BY added_at DESC LIMIT ?').all('photo', limit) as unknown as MediaRow[];
  }

  needingThumb(limit: number): MediaRow[] {
    return this.db.prepare("SELECT * FROM media WHERE kind = 'video' AND probed = 1 AND thumb IS NULL ORDER BY added_at DESC LIMIT ?").all(limit) as unknown as MediaRow[];
  }

  getMedia(id: string): MediaItem | null {
    const r = this.db.prepare(`${MEDIA_SELECT} WHERE m.id = ?`).get(id) as MediaRow | undefined;
    return r ? rowToMedia(r) : null;
  }

  getMediaRow(id: string): MediaRow | null {
    return (this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined) ?? null;
  }

  listMedia(q: { kind: MediaKind; filter?: 'all' | 'unwatched' | 'recent'; sort?: 'title' | 'added' | 'played'; search?: string; limit?: number; offset?: number }): MediaItem[] {
    const where: string[] = ['m.kind = ?'];
    const params: SQLInputValue[] = [q.kind];
    if (q.filter === 'unwatched') where.push('(h.watched IS NULL OR h.watched = 0)');
    if (q.search) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.artist LIKE ? ESCAPE '\\' OR m.album LIKE ? ESCAPE '\\')");
      const like = `%${q.search.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like, like);
    }
    const order =
      q.sort === 'added' || q.filter === 'recent'
        ? 'm.added_at DESC, m.title COLLATE NOCASE'
        : q.sort === 'played'
          ? 'h.last_played_at DESC NULLS LAST, m.title COLLATE NOCASE'
          : q.kind === 'audio'
            ? 'm.artist COLLATE NOCASE, m.album COLLATE NOCASE, m.file_name COLLATE NOCASE'
            : 'm.title COLLATE NOCASE';
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = this.db.prepare(`${MEDIA_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...params) as unknown as MediaRow[];
    return rows.map(rowToMedia);
  }

  continueWatching(limit = 20): MediaItem[] {
    const rows = this.db
      .prepare(`${MEDIA_SELECT} WHERE m.kind = 'video' AND h.watched = 0 AND h.position > 15 ORDER BY h.last_played_at DESC LIMIT ?`)
      .all(limit) as unknown as MediaRow[];
    return rows.map(rowToMedia);
  }

  recentlyPlayed(limit = 20): MediaItem[] {
    const rows = this.db.prepare(`${MEDIA_SELECT} WHERE h.last_played_at IS NOT NULL ORDER BY h.last_played_at DESC LIMIT ?`).all(limit) as unknown as MediaRow[];
    return rows.map(rowToMedia);
  }

  counts(): Record<MediaKind, number> {
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM media GROUP BY kind').all() as Array<{ kind: MediaKind; n: number }>;
    const out: Record<MediaKind, number> = { video: 0, audio: 0, photo: 0 };
    for (const r of rows) out[r.kind] = r.n;
    return out;
  }

  // ---- history ----
  getHistory(mediaId: string): WatchHistory | null {
    const r = this.db.prepare('SELECT * FROM history WHERE media_id = ?').get(mediaId) as
      | { position: number; duration: number; watched: number; last_played_at: number; play_count: number }
      | undefined;
    return r ? { position: r.position, duration: r.duration, watched: Boolean(r.watched), lastPlayedAt: r.last_played_at, playCount: r.play_count } : null;
  }

  saveHistory(mediaId: string, position: number, duration: number, watched: boolean, countPlay: boolean): void {
    this.db
      .prepare(
        `INSERT INTO history (media_id, position, duration, watched, last_played_at, play_count) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(media_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, watched = excluded.watched,
         last_played_at = excluded.last_played_at, play_count = history.play_count + ?`,
      )
      .run(mediaId, position, duration, watched ? 1 : 0, Date.now(), countPlay ? 1 : 0, countPlay ? 1 : 0);
  }

  clearHistory(mediaId: string): void {
    this.db.prepare('DELETE FROM history WHERE media_id = ?').run(mediaId);
  }

  // ---- devices ----
  devices(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as DeviceRow[];
  }

  device(id: string): DeviceRow | null {
    return (this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined) ?? null;
  }

  addDevice(d: { id: string; name: string; secret: string; protectedSecret: boolean }): void {
    this.db.prepare('INSERT INTO devices (id, name, secret, secret_protected, created_at) VALUES (?, ?, ?, ?, ?)').run(d.id, d.name, d.secret, d.protectedSecret ? 1 : 0, Date.now());
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  removeDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  // ---- audit events ----
  logEvent(kind: string, detail: string): void {
    this.db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(Date.now(), kind, detail.slice(0, 500));
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)').run();
  }

  recentEvents(limit = 50): Array<{ at: number; kind: string; detail: string }> {
    return this.db.prepare('SELECT at, kind, detail FROM events ORDER BY id DESC LIMIT ?').all(limit) as Array<{ at: number; kind: string; detail: string }>;
  }
}
