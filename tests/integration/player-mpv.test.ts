import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NovaDatabase } from '../../src/main/db';
import { setUserDataDir } from '../../src/main/paths';
import { PlayerService } from '../../src/main/player/player-service';
import { SettingsStore } from '../../src/main/settings-store';
import type { PlayerState } from '../../src/shared/types';
import { hasBinary, hasDisplay, makeTestVideo } from '../helpers/media';

const canRun = hasBinary('mpv') && hasBinary('ffmpeg') && hasDisplay;

describe.skipIf(!canRun)('PlayerService with real mpv', () => {
  let dir: string;
  let db: NovaDatabase;
  let settings: SettingsStore;
  let player: PlayerService;
  let movie: string;
  let mediaId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-player-'));
    setUserDataDir(dir);
    const srt = path.join(dir, 'subs.srt');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:30,000\nHello NOVA\n');
    movie = makeTestVideo(dir, 'movie.mkv', [
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-i', srt,
      '-t', '30', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ara', '-metadata:s:s:0', 'language=eng',
    ]);
    db = new NovaDatabase(path.join(dir, 'nova.db'));
    settings = new SettingsStore(db);
    settings.update({ audio: { device: 'null' } });
    const root = db.addRoot(dir, 'video');
    mediaId = 'test-movie';
    db.upsertMedia({ id: mediaId, rootId: root.id, path: movie, kind: 'video', title: 'Test Movie', fileName: 'movie.mkv', size: fs.statSync(movie).size, mtime: 1 });
    player = new PlayerService(db, settings, {
      embedHandle: () => null,
      standaloneGeometry: () => ({ x: 0, y: 0, width: 640, height: 360 }),
    });
  });

  afterAll(async () => {
    await player?.dispose();
    db?.close();
  });

  const waitFor = async (pred: (s: PlayerState) => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(player.state)) return player.state;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout; last state: ${JSON.stringify({ ...player.state, tracks: undefined })}`);
  };

  it('plays a library item and reports progress', async () => {
    await player.open({ mediaId });
    const s = await waitFor((st) => st.status === 'playing' && st.position > 1);
    expect(s.media?.title).toBe('Test Movie');
    expect(s.duration).toBeGreaterThan(29);
    expect(s.engine.mode).toBe('standalone');
    expect(s.video?.width).toBe(640);
  });

  it('lists audio and subtitle tracks and switches them', async () => {
    const s = await waitFor((st) => st.tracks.filter((t) => t.type === 'audio').length === 2);
    expect(s.tracks.some((t) => t.type === 'sub' && t.lang === 'eng')).toBe(true);
    const arabic = s.tracks.find((t) => t.type === 'audio' && t.lang === 'ara')!;
    await player.command({ type: 'track', kind: 'audio', id: arabic.id });
    await waitFor((st) => st.tracks.some((t) => t.id === arabic.id && t.type === 'audio' && t.selected));
    const sub = s.tracks.find((t) => t.type === 'sub')!;
    await player.command({ type: 'track', kind: 'sub', id: sub.id });
    await waitFor((st) => st.tracks.some((t) => t.type === 'sub' && t.selected));
    await player.command({ type: 'track', kind: 'sub', id: 'off' });
    await waitFor((st) => !st.tracks.some((t) => t.type === 'sub' && t.selected));
  });

  it('pauses, resumes and seeks', async () => {
    await player.command({ type: 'pause' });
    await waitFor((st) => st.status === 'paused');
    const pos = player.state.position;
    await new Promise((r) => setTimeout(r, 700));
    expect(Math.abs(player.state.position - pos)).toBeLessThan(0.2);
    await player.command({ type: 'seek', mode: 'absolute', value: 20 });
    await waitFor((st) => Math.abs(st.position - 20) < 1.5);
    await player.command({ type: 'toggle' });
    await waitFor((st) => st.status === 'playing' && st.position > 20.5);
  });

  it('changes volume within bounds and persists it', async () => {
    await player.command({ type: 'volume', action: 'set', value: 200 });
    await waitFor((st) => st.volume === 130);
    await player.command({ type: 'volume', action: 'down' });
    await waitFor((st) => st.volume === 125);
    expect(settings.get().audio.volume).toBe(125);
  });

  it('saves watch history and resumes from it', async () => {
    await player.command({ type: 'seek', mode: 'absolute', value: 18 });
    await waitFor((st) => Math.abs(st.position - 18) < 1.5);
    await player.stop();
    const h = db.getHistory(mediaId);
    expect(h?.position).toBeGreaterThan(17);
    expect(h?.watched).toBe(false);
    expect(db.continueWatching().map((m) => m.id)).toContain(mediaId);
    await player.open({ mediaId });
    const s = await waitFor((st) => st.status === 'playing' && st.position > 15);
    expect(s.position).toBeLessThan(25);
  });

  it('reports an unplayable file without crashing', async () => {
    const bad = path.join(dir, 'broken.mp4');
    fs.writeFileSync(bad, Buffer.from('this is not a video file at all'));
    await player.open({ path: bad, title: 'Broken' });
    const s = await waitFor((st) => st.status === 'error');
    expect(s.error).toMatch(/could not be played/);
    // The engine is still alive and can play again.
    await player.open({ mediaId });
    await waitFor((st) => st.status === 'playing');
  });

  it('recovers playback after the mpv process dies', async () => {
    await waitFor((st) => st.status === 'playing' && st.position > 16);
    const before = player.state.position;
    // Simulate a crash of the video engine.
    (player as unknown as { proc: { kill(sig: string): void } }).proc.kill('SIGKILL');
    const s = await waitFor((st) => st.engine.restarts === 1 && st.status === 'playing' && st.position >= before - 1, 20000);
    expect(s.media?.id).toBe(mediaId);
  });
});
