import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NovaDatabase } from '../../src/main/db';
import { LibraryService, isForbiddenRoot } from '../../src/main/library/library-service';
import { audioTagsFromPath, cleanTitle, kindForFile } from '../../src/main/library/naming';
import { parseFfprobe, parseMpvProbe } from '../../src/main/library/probe';
import { setUserDataDir } from '../../src/main/paths';
import { SettingsStore } from '../../src/main/settings-store';

describe('naming', () => {
  it.each([
    ['The.Matrix.1999.1080p.BluRay.x264-GRP.mkv', 'The Matrix (1999)'],
    ['Blade Runner 2049 (2017) 2160p HDR.mkv', 'Blade Runner 2049 (2017)'],
    ['Some_Home_Video.mp4', 'Some Home Video'],
    ['Breaking.Bad.S02E05.720p.WEB-DL.mkv', 'Breaking Bad S02E05'],
    ['[Group] Show Name - 03 [1080p].mkv', 'Show Name - 03'],
    ['holiday 2019.mov', 'holiday (2019)'],
  ])('cleanTitle(%s) = %s', (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });

  it('classifies files by extension', () => {
    expect(kindForFile('a.MKV')).toBe('video');
    expect(kindForFile('a.flac')).toBe('audio');
    expect(kindForFile('a.JPEG')).toBe('photo');
    expect(kindForFile('a.exe')).toBeNull();
  });

  it('derives audio tags from folders', () => {
    const root = path.join('/music');
    expect(audioTagsFromPath('/music/Fairuz/Best Of/01 - Kifak Inta.flac', root)).toEqual({ artist: 'Fairuz', album: 'Best Of', title: 'Kifak Inta' });
    expect(audioTagsFromPath('/music/Artist Name - Song.mp3', root)).toEqual({ artist: 'Artist Name', album: null, title: 'Song' });
  });
});

describe('probe parsers', () => {
  it('parses ffprobe JSON', () => {
    const r = parseFfprobe(
      JSON.stringify({
        format: { duration: '5400.5', tags: { TITLE: 'Film' } },
        streams: [
          { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '24000/1001', color_transfer: 'smpte2084' },
          { codec_type: 'audio', codec_name: 'eac3' },
        ],
      }),
    );
    expect(r).toMatchObject({ duration: 5400.5, width: 3840, height: 2160, videoCodec: 'hevc', audioCodec: 'eac3', hdr: 'HDR10', title: 'Film' });
    expect(r.fps).toBeCloseTo(23.976, 2);
  });

  it('parses the mpv fallback probe line', () => {
    const r = parseMpvProbe('junk\nNOVAPROBE|120.5|video|1920|1080|h264|25.000|bt.1886|(unavailable)|(unavailable)|(unavailable)|aac\n');
    expect(r).toMatchObject({ duration: 120.5, width: 1920, height: 1080, videoCodec: 'h264', fps: 25, hdr: null, audioCodec: 'aac', title: null });
    expect(parseMpvProbe('nothing')).toBeNull();
  });
});

describe('LibraryService scanning', () => {
  let dir: string;
  let db: NovaDatabase;
  let lib: LibraryService;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lib-'));
    setUserDataDir(path.join(dir, 'userdata'));
    const media = path.join(dir, 'Movies');
    fs.mkdirSync(path.join(media, 'Series', 'Season 1'), { recursive: true });
    fs.mkdirSync(path.join(media, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(media, 'Film.2020.1080p.mkv'), 'x');
    fs.writeFileSync(path.join(media, 'Series', 'Season 1', 'Show.S01E01.mp4'), 'x');
    fs.writeFileSync(path.join(media, '.hidden', 'secret.mp4'), 'x');
    fs.writeFileSync(path.join(media, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(media, 'cover.jpg'), 'x');
    db = new NovaDatabase(path.join(dir, 'nova.db'));
    lib = new LibraryService(db, new SettingsStore(db));
  });

  afterAll(() => db.close());

  it('rejects whole system drives and missing folders', () => {
    expect(isForbiddenRoot('/')).toBe(true);
    expect(() => lib.addRoot(path.join(dir, 'missing'), 'video')).toThrow(/does not exist/);
  });

  it('indexes only matching media types, skipping hidden folders', async () => {
    const root = db.addRoot(path.join(dir, 'Movies'), 'video');
    await lib.scan();
    const items = db.listMedia({ kind: 'video' });
    expect(items.map((i) => i.title).sort()).toEqual(['Film (2020)', 'Show S01E01']);
    expect(lib.isInsideRoot(path.join(dir, 'Movies', 'Film.2020.1080p.mkv'), 'video')).toBe(true);
    expect(lib.isInsideRoot(path.join(dir, 'other.mkv'), 'video')).toBe(false);
    expect(lib.isInsideRoot(path.join(dir, 'Movies', '..', 'x.mkv'), 'video')).toBe(false);
    expect(root.kind).toBe('video');
  });

  it('removes entries for deleted files on rescan and keeps history consistent', async () => {
    const film = db.listMedia({ kind: 'video' }).find((i) => i.title === 'Film (2020)')!;
    db.saveHistory(film.id, 100, 5000, false, true);
    expect(db.continueWatching()[0]?.id).toBe(film.id);
    fs.rmSync(path.join(dir, 'Movies', 'Film.2020.1080p.mkv'));
    await lib.scan();
    expect(db.listMedia({ kind: 'video' }).map((i) => i.title)).toEqual(['Show S01E01']);
    expect(db.continueWatching()).toEqual([]);
  });
});
