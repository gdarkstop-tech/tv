import path from 'node:path';
import type { MediaKind } from '../../shared/types';

// File-type classification and human-friendly titles. Pure functions.

export const EXTENSIONS: Record<MediaKind, Set<string>> = {
  video: new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.flv', '.ogv', '.3gp', '.vob']),
  audio: new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.alac', '.aiff', '.aif', '.ape', '.wv']),
  photo: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']),
};

export function kindForFile(file: string): MediaKind | null {
  const ext = path.extname(file).toLowerCase();
  for (const k of ['video', 'audio', 'photo'] as MediaKind[]) if (EXTENSIONS[k].has(ext)) return k;
  return null;
}

const RELEASE_TOKENS =
  /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dolby\s?vision|sdr|x264|x265|h\.?264|h\.?265|hevc|avc|av1|vp9|10bit|8bit|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|web|hdtv|dvdrip|remux|proper|repack|extended|unrated|imax|aac(?:2\.0)?|ac3|eac3|ddp?5\.1|dts(?:-hd)?|truehd|atmos|5\.1|7\.1|multi|subs?)\b/i;

/** "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv" → "The Matrix (1999)" */
export function cleanTitle(fileName: string): string {
  let base = fileName.replace(/\.[^.]+$/, '');
  base = base.replace(/\[[^\]]*\]/g, ' ');
  // Episode pattern: keep "Show S01E02" readable.
  const ep = base.match(/^(.*?)[\s._-]+[sS](\d{1,2})[eE](\d{1,3})/);
  if (ep) {
    const show = ep[1]!.replace(/[._]+/g, ' ').trim();
    return `${show} S${ep[2]!.padStart(2, '0')}E${ep[3]!.padStart(2, '0')}`;
  }
  const words = base.replace(/[._]+/g, ' ').split(/\s+/).filter(Boolean);
  // Everything from the first release tag onwards is noise.
  let cut = words.findIndex((w, i) => i > 0 && RELEASE_TOKENS.test(w));
  if (cut < 0) cut = words.length;
  const head = words.slice(0, cut);
  // Year: a parenthesised year wins; otherwise the last year-like token
  // (so "Blade Runner 2049 2017" keeps 2049 in the title).
  const isYear = (w: string) => /^\(?(19|20)\d{2}\)?$/.test(w);
  let yearIdx = head.findIndex((w, i) => i > 0 && /^\((19|20)\d{2}\)$/.test(w));
  if (yearIdx < 0) {
    for (let i = head.length - 1; i > 0; i--) {
      if (isYear(head[i]!)) {
        yearIdx = i;
        break;
      }
    }
  }
  const year = yearIdx > 0 ? head[yearIdx]!.replace(/[()]/g, '') : null;
  const titleWords = yearIdx > 0 ? head.slice(0, yearIdx) : head;
  // Drop a trailing "-GROUP" release-group suffix.
  if (titleWords.length > 1) titleWords[titleWords.length - 1] = titleWords[titleWords.length - 1]!.replace(/-[A-Z0-9]{2,8}$/, '');
  const title = (titleWords.join(' ') || words.join(' ')).replace(/\s+-\s*$/, '').trim();
  return year ? `${title} (${year})` : title;
}

/** Derive artist/album/title for audio files from "Artist/Album/01 - Title.flac". */
export function audioTagsFromPath(file: string, root: string): { artist: string | null; album: string | null; title: string } {
  const rel = path.relative(root, file).split(/[\\/]/);
  const name = path.basename(file).replace(/\.[^.]+$/, '');
  let title = name.replace(/^\d{1,3}[\s._-]+/, '').trim();
  let artist: string | null = null;
  let album: string | null = null;
  if (rel.length >= 3) {
    artist = rel[rel.length - 3] ?? null;
    album = rel[rel.length - 2] ?? null;
  } else if (rel.length === 2) album = rel[0] ?? null;
  const dash = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash && !artist) {
    artist = dash[1]!.trim();
    title = dash[2]!.trim();
  }
  return { artist, album, title: title || name };
}
