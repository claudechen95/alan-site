import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { vi } from "vitest";
import { getReflectionPrompt } from "@/lib/kv";
import type { Goal } from "@/lib/types";
import { fakeRedis } from "./redis-fake";

// Pinned to a Wednesday so every scenario is constructible and none of them depend on the day
// the suite happens to run. Wed 26 Aug 2026, 11:00 PDT: the week runs Mon 24 - Sun 30, so
// there are 5 days left in it (Wed through Sun) and 2 already spent.
const NOW = new Date("2026-08-26T18:00:00Z");
const MONDAY = "2026-08-24";
const U = "testuser"; // not Alan's namespace, so getGoals' Alan-only migrations stay out of it

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

const weekDay = (i: number) => shift(MONDAY, i);
const lastWeekDay = (i: number) => shift(MONDAY, i - 7);

/** Give the goal some check-in history, which is what makes it eligible to be prompted at all. */
function seedCheckIns(goalId: string, dates: string[]) {
  for (const date of dates) fakeRedis.seed(`${U}:checkin:${goalId}:${date}`, 1);
  fakeRedis.seedListEntry(`${U}:history:${goalId}`, {
    goalId,
    timestamp: 1,
    date: dates[0] ?? MONDAY,
    week: "seed",
  });
}

const weekly = (id: string, targetCount: number): Goal =>
  ({ id, name: id, emoji: "x", frequency: "weekly", targetCount });
const daily = (id: string): Goal =>
  ({ id, name: id, emoji: "x", frequency: "daily", targetCount: 1 });

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => fakeRedis.reset());

describe("getReflectionPrompt - daily goals", () => {
  it("asks, and requires an answer, when yesterday had no check-in", async () => {
    seedCheckIns("d", [shift("2026-08-26", -3)]);
    expect(await getReflectionPrompt(daily("d"), U)).toEqual({
      reason: "missed-day",
      date: "2026-08-25",
      required: true,
    });
  });

  it("stays quiet when yesterday was done", async () => {
    seedCheckIns("d", ["2026-08-25"]);
    expect(await getReflectionPrompt(daily("d"), U)).toBeNull();
  });

  it("stays quiet when yesterday was a vacation day", async () => {
    seedCheckIns("d", [shift("2026-08-26", -10)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: "2026-08-20", endDate: "2026-08-26", goalIds: ["d"] },
    ]);
    expect(await getReflectionPrompt(daily("d"), U)).toBeNull();
  });
});

describe("getReflectionPrompt - weekly goals", () => {
  // The point of the weekly rules: a 3x/week habit is scored over the whole week, so one
  // skipped day mid-week is not a miss and must not be treated as one.
  it("says nothing about a mid-week skip while the target is still comfortable", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(2), lastWeekDay(4), weekDay(0)]);
    // 1 of 3 done, 5 days left: 2 still needed against 5 open days is not behind.
    expect(await getReflectionPrompt(weekly("w", 3), U)).toBeNull();
  });

  it("asks, but does not require, when the week is winnable only if every day lands", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4)]);
    // 0 of 5 done with exactly 5 days left. Still achievable, and the user is checking in right
    // now, so charging them for good behaviour would turn the prompt into noise.
    expect(await getReflectionPrompt(weekly("w", 5), U)).toEqual({
      reason: "week-behind",
      completed: 0,
      target: 5,
      daysLeft: 5,
      required: false,
    });
  });

  it("requires a reflection once the target is out of reach", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4), lastWeekDay(5), lastWeekDay(6)]);
    // 0 of 7 with 5 days left: the week is lost, so the only useful move is naming why.
    expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({
      reason: "week-behind",
      required: true,
    });
  });

  it("catches a week that quietly closed short, on the first check-in of the new one", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1)]);
    expect(await getReflectionPrompt(weekly("w", 3), U)).toEqual({
      reason: "week-missed",
      completed: 2,
      target: 3,
      required: true,
    });
  });

  it("says nothing when last week hit its target", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(2), lastWeekDay(4)]);
    expect(await getReflectionPrompt(weekly("w", 2), U)).toBeNull();
  });

  it("says nothing while a vacation covers both the current and previous week", async () => {
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: lastWeekDay(0), endDate: weekDay(6), goalIds: ["w"] },
    ]);
    // Both weeks prorate to a target of 0, so neither can be behind or missed.
    expect(await getReflectionPrompt(weekly("w", 3), U)).toBeNull();
  });

  it("prorates the target down for paused days instead of counting them as misses", async () => {
    // 5x/week, done Mon and Tue, then Wed-Sun paused. Only 2 days of the week were ever
    // available, so the target prorates 5 -> 2 and the habit is square. Without proration this
    // would read as 2 of 5 with 0 days left, i.e. a required "you blew the week" prompt for
    // days the user was never expected to show up on.
    seedCheckIns("w", [weekDay(0), weekDay(1)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: weekDay(2), endDate: weekDay(6), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 5), U)).toBeNull();
  });

  it("still reports a genuinely missed previous week when only the current week is paused", async () => {
    // The pause says nothing about last week, which really did close at 0 of 3.
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: MONDAY, endDate: weekDay(6), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 3), U)).toMatchObject({
      reason: "week-missed",
      required: true,
    });
  });
});

describe("getReflectionPrompt - when not to ask at all", () => {
  it("never prompts a brand-new habit with no history", async () => {
    expect(await getReflectionPrompt(weekly("fresh", 3), U)).toBeNull();
  });

  it("never prompts a graduated habit, which has no expectations left to fall behind", async () => {
    seedCheckIns("g", [lastWeekDay(0), lastWeekDay(1)]);
    const graduated: Goal = { ...weekly("g", 3), graduatedAt: "2026-08-20", graduatedRun: 12 };
    // Same data that produced a required week-missed above.
    expect(await getReflectionPrompt(graduated, U)).toBeNull();
  });
});
