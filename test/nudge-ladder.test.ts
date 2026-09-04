import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/dispatch/route";
import type { Goal } from "@/lib/types";

// End-to-end over the dispatch route, one simulated PST day at a time. The pure schedule maths
// is covered in nudges.test.ts; what's checked here is the part that only exists in the route -
// that the five steps fire once each, in order, and that the escape hatches escape exactly as
// much as they're supposed to.
//
// The clock is the input under test, so every tick is a real POST at a real (faked) system time
// rather than a time argument threaded in. That's the only way this exercises the same
// getPstTimeHHMM/getTodayDate path production runs on.

const { texts, calls } = vi.hoisted(() => ({
  texts: [] as { to: string; body: string }[],
  calls: [] as { to: string; script: string }[],
}));

vi.mock("@/lib/sendblue", () => ({
  sendText: async (to: string, content: string) => {
    texts.push({ to, body: content });
  },
}));

vi.mock("@/lib/call", () => ({
  isCallConfigured: () => true,
  placeCall: async (to: string, script: string) => {
    calls.push({ to, script });
  },
}));

const TODAY = "2026-08-26"; // Wednesday, PDT (UTC-7)
const SECRET = "test-dispatch-secret";
const PHONE = "+15550000001";
const PARTNER = "+15550000002";

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fmt(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function tickAt(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  // PDT is UTC-7, and Date handles the rollover into the next UTC day for evening PST times.
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 26, h + 7, m)));
  await POST(
    new Request("http://localhost/api/nudge/dispatch", {
      method: "POST",
      headers: { "x-nudge-secret": SECRET },
    })
  );
}

/** Runs the real cron cadence - every 10 minutes, 8am to 11pm PST - and logs what went out. */
async function runDay(): Promise<string[]> {
  const log: string[] = [];
  for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
    const at = fmt(m);
    const seen = { t: texts.length, c: calls.length };
    await tickAt(at);
    for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
    for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
  }
  return log;
}

function seedUser(overrides: Partial<{ phone: string; partnerPhone: string }> = {}) {
  fakeRedis.seed("users", [
    { id: "tester", label: "Tester", phone: PHONE, partnerPhone: PARTNER, ...overrides },
  ]);
}

const salad: Goal = {
  id: "salad",
  name: "Salad",
  emoji: "🥗",
  frequency: "daily",
  targetCount: 1,
  nudgeTime: "18:00",
};

beforeAll(() => {
  vi.useFakeTimers();
  process.env.NUDGE_DISPATCH_SECRET = SECRET;
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  fakeRedis.reset();
  texts.length = 0;
  calls.length = 0;
  seedUser();
  fakeRedis.seed("tester:goals", [salad]);
});

describe("the nudge ladder over a full day", () => {
  it("sends three texts, then calls, then tells the partner", async () => {
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `22:00 call→${PHONE}`,
      `22:30 text→${PARTNER}`,
    ]);
  });

  it("says the habit out loud on the call", async () => {
    await runDay();
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(
      "Hey Tester. This is your accountability check. You still have 1 habit open today: Salad. Open the app to check it off."
    );
  });

  it("stays silent all day once the habit is done", async () => {
    fakeRedis.seed(`tester:checkin:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([]);
  });

  it("stops at the call when there's no partner to escalate to", async () => {
    seedUser({ partnerPhone: undefined });
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `22:00 call→${PHONE}`,
    ]);
  });
});

describe("snoozing", () => {
  // The whole point of the design: a snooze is a mute button on your own phone, not an exit
  // from the accountability. Only finishing the habit stops step 5.
  it("silences your own phone but still tells your partner", async () => {
    fakeRedis.seed(`tester:nudge:snoozed:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([`22:30 text→${PARTNER}`]);
  });

  it("snoozing mid-evening drops the remaining texts and the call", async () => {
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      if (at === "19:00") fakeRedis.seed(`tester:nudge:snoozed:salad:${TODAY}`, 1);
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([`18:00 text→${PHONE}`, `22:30 text→${PARTNER}`]);
  });
});

describe("per-habit scheduling", () => {
  it("gives every habit its own three texts regardless of when it starts", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "09:00" },
      { ...salad, id: "gym", name: "Gym", nudgeTime: "18:00" },
    ]);
    const log = await runDay();
    // The 09:00 habit runs 09:00/13:20/17:40; the 18:00 one runs 18:00/19:20/20:40. They share
    // the 18:00-ish window without either losing a reminder, and both land in one call.
    expect(log.filter((l) => l.includes(`text→${PHONE}`))).toHaveLength(6);
    expect(log).toContain(`09:00 text→${PHONE}`);
    expect(log).toContain(`22:00 call→${PHONE}`);
    expect(calls[0].script).toContain("2 habits open today: Salad, and Gym");
  });

  it("fits three texts in even when the habit starts at 9pm", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, nudgeTime: "21:00" }]);
    expect(await runDay()).toEqual([
      `21:00 text→${PHONE}`,
      `21:20 text→${PHONE}`,
      `21:40 text→${PHONE}`,
      `22:00 call→${PHONE}`,
      `22:30 text→${PARTNER}`,
    ]);
  });
});

describe("idempotence", () => {
  // Overlapping or retried cron invocations are the reason every step claims its slot before
  // sending. Ten identical ticks at one slot time must produce exactly one message.
  it("never double-sends when the same tick is replayed", async () => {
    for (let i = 0; i < 10; i++) await tickAt("18:00");
    expect(texts).toHaveLength(1);

    for (let i = 0; i < 10; i++) await tickAt("22:00");
    expect(calls).toHaveLength(1);

    for (let i = 0; i < 10; i++) await tickAt("22:30");
    expect(texts.filter((t) => t.to === PARTNER)).toHaveLength(1);
  });

  it("rejects a tick without the shared secret", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 1, 0))); // 18:00 PDT
    const res = await POST(new Request("http://localhost/api/nudge/dispatch", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(texts).toHaveLength(0);
  });
});
