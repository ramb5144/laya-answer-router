import type { PageContext } from './types.js';

export type StoredPageContext = {
  context: PageContext;
  capturedAt: string;
  ageMs: number;
};

type StoredEntry = {
  context: PageContext;
  capturedAtMs: number;
};

export class RecentContextStore {
  private latest: StoredEntry | undefined;

  constructor(
    private readonly ttlMs = 15 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  set(context: PageContext): StoredPageContext {
    const capturedAtMs = this.now();
    this.latest = { context: { ...context }, capturedAtMs };
    return this.toPublic(this.latest, capturedAtMs);
  }

  get(): StoredPageContext | undefined {
    if (!this.latest) return undefined;
    const now = this.now();
    if (now - this.latest.capturedAtMs > this.ttlMs) {
      this.latest = undefined;
      return undefined;
    }
    return this.toPublic(this.latest, now);
  }

  private toPublic(entry: StoredEntry, now: number): StoredPageContext {
    return {
      context: { ...entry.context },
      capturedAt: new Date(entry.capturedAtMs).toISOString(),
      ageMs: Math.max(0, now - entry.capturedAtMs),
    };
  }
}
