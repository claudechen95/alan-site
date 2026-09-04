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

const { texts, calls, phone } = vi.hoisted(() => ({
  texts: [] as { to: string; body: string }[],
  calls: [] as { to: string; script: string }[],
  // Stands in for the person being called. `outcome` is what Twilio would report about the last
  // attempt, which is the only thing that decides whether the ladder rings again - so these
  // tests set it to drive the retry loop rather than mocking Twilio's HTTP shape.
  phone: { outcome: "missed" as "reached" | "missed" | "pending" },
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
    return `CA${calls.length}`;
  },
  getCallOutcome: async () => phone.outcome,
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
  phone.outcome = "missed";
  seedUser();
  fakeRedis.seed("tester:goals", [salad]);
});

describe("the nudge ladder over a full day", () => {
  it("sends three texts, calls three times, then tells the partner", async () => {
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
      `21:40 text→${PARTNER}`,
    ]);
  });

  it("says the habit out loud on the call", async () => {
    await runDay();
    expect(calls[0].script).toBe(
      "Hey Tester. This is your accountability check. You still have 1 habit open today: Salad. Open the app to check it off."
    );
  });

  it("stays silent all day once the habit is done", async () => {
    fakeRedis.seed(`tester:checkin:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([]);
  });

  it("stops at the calls when there's no partner to escalate to", async () => {
    seedUser({ partnerPhone: undefined });
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
    ]);
  });
});

// The reason step 4 retries at all: one ring is trivially declined, and being in a meeting is
// exactly when the call matters. Twilio reports a voicemail pickup as `completed`, identical to
// a human answering, so lib/call.ts leans on answering-machine detection to tell them apart -
// getCallOutcome collapses that to reached/missed/pending and this is what the route does with it.
describe("calling until someone picks up", () => {
  it("gives up after three attempts and hands over to the partner", async () => {
    const log = await runDay();
    expect(log.filter((l) => l.includes("call"))).toEqual([
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
    ]);
  });

  it("stops calling once a person answers, and lets them off the partner alert", async () => {
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      // The 20:50 call connects; every tick after that sees a reached call.
      if (at === "21:00") phone.outcome = "reached";
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    // One call, and crucially no partner text - answering is a live acknowledgement, unlike a
    // snooze, so it ends the day for every habit at once.
    expect(log).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
    ]);
  });

  it("waits rather than redialling while the previous call is still ringing", async () => {
    phone.outcome = "pending";
    await tickAt("22:00");
    await tickAt("22:10");
    await tickAt("22:20");
    expect(calls).toHaveLength(1);

    // Once it resolves as missed, the ladder picks up where it left off instead of having
    // burned the attempts it spent waiting.
    phone.outcome = "missed";
    await tickAt("22:30");
    await tickAt("22:40");
    expect(calls).toHaveLength(3);
  });

  it("delays the partner alert to 30 min after the last call, not the first", async () => {
    const log = await runDay();
    expect(log).toContain(`21:10 call→${PHONE}`);
    expect(log).toContain(`21:40 text→${PARTNER}`);
    // 30 min after the *first* attempt would have been 21:20.
    expect(log).not.toContain(`21:20 text→${PARTNER}`);
  });
});

describe("snoozing", () => {
  // The whole point of the design: a snooze is a mute button on your own phone, not an exit
  // from the accountability. Only finishing the habit stops step 5.
  // With everything snoozed no call is placed at all, so there's no last-attempt time to hang
  // the countdown off - it falls back to the escalation time, and the partner still hears at
  // DAY_END + 30 exactly as before retries existed.
  it("silences your own phone but still tells your partner", async () => {
    fakeRedis.seed(`tester:nudge:snoozed:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([`21:20 text→${PARTNER}`]);
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
    expect(log).toEqual([`18:00 text→${PHONE}`, `21:20 text→${PARTNER}`]);
  });
});

// Answering the text is treated exactly like answering the phone: the escalation's job was to
// reach a person, and a reply proves it did. Deliberately a much weaker bar than a snooze -
// "ok" clears it - and unlike a snooze it does silence the partner alert too.
describe("replying to a text", () => {
  it("ends the whole day - no more texts, no call, no partner", async () => {
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      // Replying just after the first text lands.
      if (at === "18:10") fakeRedis.seed(`tester:nudge:replied:${TODAY}`, "18:05");
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([`18:00 text→${PHONE}`]);
  });

  it("silences the ladder even when the reply arrives before any nudge went out", async () => {
    fakeRedis.seed(`tester:nudge:replied:${TODAY}`, "09:00");
    expect(await runDay()).toEqual([]);
  });
});

describe("per-habit scheduling", () => {
  // The headline of making calls per-habit: two habits on different clocks run two completely
  // independent ladders, and neither waits for the other.
  it("gives every habit its own texts and its own call ladder", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "09:00" },
      { ...salad, id: "gym", name: "Gym", nudgeTime: "18:00" },
    ]);
    const log = await runDay();

    // Salad runs 09:00/13:20/17:40 then calls from 17:50; Gym runs 18:00/19:20/20:40 then calls
    // from 20:50. Gym is still sending its first text after Salad has already been called about.
    expect(log.filter((l) => l.includes(`text→${PHONE}`))).toHaveLength(6);
    expect(log).toContain(`09:00 text→${PHONE}`);
    expect(log).toContain(`17:50 call→${PHONE}`);
    expect(log).toContain(`18:00 text→${PHONE}`);
    expect(log).toContain(`20:50 call→${PHONE}`);

    // Each call names only the habit whose ladder reached it.
    expect(calls[0].script).toContain("1 habit open today: Salad.");
    expect(calls.at(-1)!.script).toContain("1 habit open today: Gym.");
  });

  // Regression: when the call was a single per-user ladder pinned near DAY_END, reaching that
  // cutoff short-circuited the text block, so a habit configured past it got neither a text nor
  // a call and went silent all day. Per-habit ladders remove the cutoff entirely.
  it("still nudges and calls a habit configured past DAY_END", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, name: "Piano Session", nudgeTime: "22:30" }]);
    // One text rather than three - nudgeSlots can't divide a span that has already closed - and
    // then its own call ladder a tick later.
    expect(await runDay()).toEqual([
      `22:30 text→${PHONE}`,
      `22:40 call→${PHONE}`,
      `22:50 call→${PHONE}`,
      `23:00 call→${PHONE}`,
    ]);
  });

  it("lets a late habit text while an earlier one is already being called about", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "18:00" },
      { ...salad, id: "piano", name: "Piano Session", nudgeTime: "22:30" },
    ]);
    const log = await runDay();
    expect(log).toContain(`20:50 call→${PHONE}`); // Salad's ladder
    expect(log).toContain(`22:30 text→${PHONE}`); // Piano's first text, long after
    expect(log).toContain(`22:40 call→${PHONE}`); // and its own ladder after that
  });

  it("merges habits whose calls fall due on the same tick into one call", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "18:00" },
      { ...salad, id: "gym", name: "Gym", nudgeTime: "18:00" },
    ]);
    await runDay();
    // Dialling the same number twice on one tick would put the second call on a busy signal.
    expect(calls[0].script).toContain("2 habits open today: Salad, and Gym");
  });

  it("fits three texts in even when the habit starts at 9pm", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, nudgeTime: "21:00" }]);
    expect(await runDay()).toEqual([
      `21:00 text→${PHONE}`,
      `21:20 text→${PHONE}`,
      `21:40 text→${PHONE}`,
      `21:50 call→${PHONE}`,
      `22:00 call→${PHONE}`,
      `22:10 call→${PHONE}`,
      `22:40 text→${PARTNER}`,
    ]);
  });
});

describe("idempotence", () => {
  // Overlapping or retried cron invocations are the reason every step claims its slot before
  // sending. Ten identical ticks at one slot time must produce exactly one message.
  it("never double-sends when the same tick is replayed", async () => {
    for (let i = 0; i < 10; i++) await tickAt("18:00");
    expect(texts).toHaveLength(1);

    // Each call attempt is claimed before dialling, so a replayed tick can't ring twice - and
    // the backoff keeps the next attempt from being pulled forward into the same minute.
    for (let i = 0; i < 10; i++) await tickAt("22:00");
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 10; i++) await tickAt("22:10");
    expect(calls).toHaveLength(2);
    for (let i = 0; i < 10; i++) await tickAt("22:20");
    expect(calls).toHaveLength(3);

    for (let i = 0; i < 10; i++) await tickAt("22:50");
    expect(texts.filter((t) => t.to === PARTNER)).toHaveLength(1);
  });

  it("rejects a tick without the shared secret", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 1, 0))); // 18:00 PDT
    const res = await POST(new Request("http://localhost/api/nudge/dispatch", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(texts).toHaveLength(0);
  });
});
