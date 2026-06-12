import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";

interface CacheEntry {
  value: string;
  expiresAt: number;
  updatedAt: number;
}

interface PersistedCacheState {
  responseCache: Record<string, CacheEntry>;
}

export class FileCache {
  private readonly responseCache = new Map<string, CacheEntry>();
  private readonly statePath: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(private readonly filePath: string, options?: { ttlMs?: number; maxEntries?: number }) {
    const absPath = path.resolve(filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.statePath = absPath;
    this.defaultTtlMs = options?.ttlMs ?? 600000;
    this.maxEntries = options?.maxEntries ?? 1000;
    this.load();
    this.pruneExpired();
  }

  getResponse(key: string): string | undefined {
    const entry = this.responseCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.responseCache.delete(key);
      this.persist();
      return undefined;
    }
    return entry.value;
  }

  setResponse(key: string, value: string): void {
    this.setEntry(this.responseCache, key, value);
  }

  private setEntry(target: Map<string, CacheEntry>, key: string, value: string): void {
    const now = Date.now();
    target.set(key, {
      value,
      updatedAt: now,
      expiresAt: now + this.defaultTtlMs,
    });
    this.enforceLimit(target);
    this.persist();
  }

  private enforceLimit(target: Map<string, CacheEntry>): void {
    if (target.size <= this.maxEntries) return;
    const entries = [...target.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = target.size - this.maxEntries;
    for (let i = 0; i < overflow; i += 1) {
      const stale = entries[i];
      if (!stale) break;
      target.delete(stale[0]);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.responseCache.entries()) {
      if (entry.expiresAt <= now) this.responseCache.delete(key);
    }
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as PersistedCacheState;
      for (const [key, entry] of Object.entries(parsed.responseCache ?? {})) {
        this.responseCache.set(key, entry);
      }
    } catch {
      // Ignore malformed cache file and continue with empty cache.
    }
  }

  private persist(): void {
    const out: Record<string, CacheEntry> = {};
    for (const [key, entry] of this.responseCache.entries()) {
      out[key] = entry;
    }
    writeFileSync(this.statePath, JSON.stringify({ responseCache: out }), "utf8");
  }
}
