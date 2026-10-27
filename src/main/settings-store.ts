import { EventEmitter } from 'node:events';
import { mergeSettings, parseStoredSettings, type Settings } from '../shared/settings';
import type { NovaDatabase } from './db';
import { logger } from './log';

const log = logger('settings');
const KEY = 'settings';

/** Validated, persisted settings with change notifications. */
export class SettingsStore extends EventEmitter {
  private current: Settings;

  constructor(private readonly db: NovaDatabase) {
    super();
    let raw: unknown = {};
    const stored = db.kvGet(KEY);
    if (stored) {
      try {
        raw = JSON.parse(stored);
      } catch {
        log.warn('stored settings were not valid JSON; using defaults');
      }
    }
    const { settings, repaired } = parseStoredSettings(raw);
    this.current = settings;
    if (repaired && stored) log.warn('some stored settings were invalid and were reset to defaults');
    this.persist();
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  /** Apply a partial update. Throws if the result fails validation. */
  update(patch: unknown): Settings {
    const before = this.current;
    const next = mergeSettings(before, patch);
    this.current = next;
    this.persist();
    this.emit('change', structuredClone(next), before);
    return structuredClone(next);
  }

  private persist(): void {
    this.db.kvSet(KEY, JSON.stringify(this.current));
  }
}
