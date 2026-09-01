// An in-memory stand-in for @upstash/redis, so the data-layer tests run in CI with no
// credentials and no shared database. It implements exactly the command surface lib/kv.ts
// uses - if kv.ts starts using a new command, the fake throws rather than silently returning
// undefined, which is what you want: a missing command should fail loudly in a test run.
//
// Upstash semantics worth preserving, because kv.ts depends on them:
//   - `get` JSON-parses stored strings; values set as objects come back as objects.
//   - `mget` returns null (not undefined) for missing keys.
//   - lists are stored newest-first via lpush, which is how history keys are written.
export class FakeRedis {
  private store = new Map<string, unknown>();
  private lists = new Map<string, string[]>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }

  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    // The real client accepts either mget(a, b) or mget([a, b]).
    const flat = keys.flat() as string[];
    return flat.map((key) => (this.store.get(key) as T) ?? null);
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }

  async decr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
    return next;
  }

  async del(...keys: string[]): Promise<number> {
    const flat = keys.flat() as string[];
    let removed = 0;
    for (const key of flat) {
      if (this.store.delete(key)) removed++;
      if (this.lists.delete(key)) removed++;
    }
    return removed;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const all = Array.from(this.store.keys()).concat(Array.from(this.lists.keys()));
    return all.filter((key) => regex.test(key));
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const list = this.lists.get(key) ?? [];
    // Redis `stop` is inclusive and -1 means "to the end".
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end).map((raw) => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as T;
      }
    });
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    let removed = 0;
    const limit = count === 0 ? Infinity : Math.abs(count);
    const kept = list.filter((item) => {
      if (removed < limit && item === value) {
        removed++;
        return false;
      }
      return true;
    });
    this.lists.set(key, kept);
    return removed;
  }

  /** Wipe everything between tests. */
  reset(): void {
    this.store.clear();
    this.lists.clear();
  }

  /** Seed a raw value, for arranging test state without going through kv.ts. */
  seed(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  /** Seed a list entry, mirroring how kv.ts writes history records. */
  seedListEntry(key: string, value: unknown): void {
    const list = this.lists.get(key) ?? [];
    list.unshift(JSON.stringify(value));
    this.lists.set(key, list);
  }
}

// One shared instance: lib/kv.ts builds its client at module load, so the mock has to hand back
// the same object every time it's constructed.
export const fakeRedis = new FakeRedis();
