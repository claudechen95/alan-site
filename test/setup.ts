import { vi } from "vitest";
import { fakeRedis } from "./redis-fake";

// lib/kv.ts constructs its Redis client at module load, so this has to be in place before any
// test imports it. Every `new Redis(...)` hands back the same in-memory instance.
// Must be a real constructor - kv.ts calls `new Redis(...)`, and an arrow function can't be
// newed. Returning the shared instance from a constructor is legal and gives every caller the
// same store.
vi.mock("@upstash/redis", () => ({
  Redis: function Redis() {
    return fakeRedis;
  },
}));
