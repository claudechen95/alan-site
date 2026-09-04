import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/inbound/route";
import { hasReplied, getNudgeSnoozed } from "@/lib/kv";
import type { Goal } from "@/lib/types";

// Sendblue's inbound webhook. The behaviour that matters here is the authorization gate and the
// fact that *any* reply ends the day's ladder - the per-habit matching below it only decides how
// the confirmation reads, not what gets sent.

const { texts } = vi.hoisted(() => ({ texts: [] as { to: string; body: string }[] }));

vi.mock("@/lib/sendblue", () => ({
  sendText: async (to: string, content: string) => {
    texts.push({ to, body: content });
  },
}));

const TODAY = "2026-08-26"; // Wednesday, PDT
const SECRET = "test-webhook-secret";
const PHONE = "+15550000001";

const goals: Goal[] = [
  { id: "salad", name: "Salad", emoji: "🥗", frequency: "daily", targetCount: 1, nudgeTime: "18:00", nudgeNumber: 1 },
  { id: "gym", name: "Gym", emoji: "🏋️", frequency: "daily", targetCount: 1, nudgeTime: "18:00", nudgeNumber: 2 },
];

async function reply(content: string, opts: { secret?: string | null; number?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers["sb-webhook-secret"] = secret;
  return POST(
    new Request("http://localhost/api/nudge/inbound", {
      method: "POST",
      headers,
      body: JSON.stringify({ is_outbound: false, number: opts.number ?? PHONE, content }),
    })
  );
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 2, 0))); // 19:00 PDT, mid-ladder
  process.env.SENDBLUE_WEBHOOK_SECRET = SECRET;
});

afterAll(() => vi.useRealTimers());

beforeEach(() => {
  fakeRedis.reset();
  texts.length = 0;
  fakeRedis.seed("users", [{ id: "tester", label: "Tester", phone: PHONE }]);
  fakeRedis.seed("tester:goals", goals);
});

describe("authorization", () => {
  it("rejects a reply with no secret, and records nothing", async () => {
    const res = await reply("stop", { secret: null });
    expect(res.status).toBe(401);
    expect(await hasReplied("tester", TODAY)).toBe(false);
  });

  it("rejects a reply with the wrong secret", async () => {
    expect((await reply("stop", { secret: "nope" })).status).toBe(401);
    expect(await hasReplied("tester", TODAY)).toBe(false);
  });
});

describe("any reply ends the day", () => {
  it("counts a reply that names nothing at all", async () => {
    await reply("ok");
    expect(await hasReplied("tester", TODAY)).toBe(true);
  });

  it("counts a reply that names a habit", async () => {
    await reply("gym");
    expect(await hasReplied("tester", TODAY)).toBe(true);
    expect(await getNudgeSnoozed("tester", "gym", TODAY)).toBe(true);
  });

  it("counts a bare habit number", async () => {
    await reply("2");
    expect(await hasReplied("tester", TODAY)).toBe(true);
    expect(await getNudgeSnoozed("tester", "gym", TODAY)).toBe(true);
  });

  it("ignores an empty message, which is not an answer to anything", async () => {
    await reply("   ");
    expect(await hasReplied("tester", TODAY)).toBe(false);
    expect(texts).toHaveLength(0);
  });

  it("does nothing for a number belonging to no user", async () => {
    await reply("ok", { number: "+15559999999" });
    expect(await hasReplied("tester", TODAY)).toBe(false);
  });
});

describe("the confirmation text", () => {
  // Naming one habit still ends the day for all of them, so a confirmation that mentioned only
  // the named habit would read as though the rest were still live.
  it("says the whole day is off, not just the habit that was named", async () => {
    await reply("gym");
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toBe("✅ Got it: 🏋️ Gym. Nudges are off for the rest of today.");
  });

  it("still confirms a reply that named nothing", async () => {
    await reply("on it");
    expect(texts[0].body).toBe("✅ Got it. Nudges are off for the rest of today.");
  });
});
