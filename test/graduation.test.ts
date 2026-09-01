import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  getGoalStatuses,
  graduateGoal,
  ungraduateGoal,
  snoozeGraduation,
  addCheckIn,
  isGraduated,
  GraduatedGoalError,
} from "@/lib/kv";
import type { Goal } from "@/lib/types";
import { fakeRedis } from "./redis-fake";

const NOW = new Date("2026-08-26T18:00:00Z"); // Wed 26 Aug 2026, 11:00 PDT
const TODAY = "2026-08-26";
const U = "testuser";

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

function setGoals(...goals: Goal[]) {
  fakeRedis.seed(`${U}:goals`, goals);
}

/** Check the habit in on each of the last `days` days, ending yesterday. */
function seedDailyRun(goalId: string, days: number) {
  for (let i = 1; i <= days; i++) fakeRedis.seed(`${U}:checkin:${goalId}:${shift(TODAY, -i)}`, 1);
  fakeRedis.seedListEntry(`${U}:history:${goalId}`, { goalId, timestamp: 1, date: TODAY, week: "seed" });
}

const daily = (id: string): Goal => ({ id, name: id, emoji: "x", frequency: "daily", targetCount: 1 });

async function statusOf(goalId: string) {
  const statuses = await getGoalStatuses(U);
  return statuses.find((g) => g.id === goalId)!;
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => fakeRedis.reset());

describe("graduation eligibility", () => {
  it("does not offer graduation below 28 days for a daily habit", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 27);
    expect((await statusOf("a")).canGraduate).toBe(false);
  });

  it("offers graduation at exactly 28 days", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 28);
    expect((await statusOf("a")).canGraduate).toBe(true);
  });

  it("never offers graduation for a mood goal, which is a journal not a habit to master", async () => {
    setGoals({ ...daily("emotional-checkin"), type: "mood" });
    seedDailyRun("emotional-checkin", 60);
    expect((await statusOf("emotional-checkin")).canGraduate).toBe(false);
  });

  it("holds the offer back while a snooze is live, and returns it once the snooze lapses", async () => {
    setGoals({ ...daily("a"), graduationSnoozedUntil: shift(TODAY, 3) });
    seedDailyRun("a", 40);
    expect((await statusOf("a")).canGraduate).toBe(false);

    setGoals({ ...daily("a"), graduationSnoozedUntil: shift(TODAY, -1) });
    expect((await statusOf("a")).canGraduate).toBe(true);
  });
});

describe("graduating and un-graduating", () => {
  it("freezes the run at the moment of graduation", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 30);
    await graduateGoal("a", U);

    const status = await statusOf("a");
    expect(status.graduatedAt).toBe(TODAY);
    expect(status.graduatedRun).toBe(30);
    expect(isGraduated(status)).toBe(true);
  });

  it("keeps reporting the frozen run even as the check-ins recede into the past", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 30);
    await graduateGoal("a", U);

    // A month later there are no new check-ins, so a recomputed streak would read 0.
    vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
    const status = await statusOf("a");
    expect(status.streak).toBe(30);
    expect(status.canGraduate).toBe(false);
    vi.setSystemTime(NOW);
  });

  it("reports a graduated habit as complete, so nothing treats it as outstanding", async () => {
    setGoals({ ...daily("a"), targetCount: 3, graduatedAt: shift(TODAY, -5), graduatedRun: 40 });
    const status = await statusOf("a");
    expect(status.isDone).toBe(true);
    expect(status.completedThisPeriod).toBe(status.targetCount);
    expect(status.todayCount).toBe(0);
    expect(status.reflection).toBeNull();
  });

  it("returns an un-graduated habit to live tracking and snoozes the re-offer", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 30);
    await graduateGoal("a", U);
    await ungraduateGoal("a", U);

    const status = await statusOf("a");
    expect(status.graduatedAt).toBeUndefined();
    expect(status.graduatedRun).toBeUndefined();
    // Its real streak is back to being computed from the check-ins...
    expect(status.streak).toBe(30);
    // ...but it isn't immediately re-offered graduation it was just taken back from.
    expect(status.graduationSnoozedUntil).toBe(shift(TODAY, 14));
    expect(status.canGraduate).toBe(false);
  });

  it("snoozes for 14 days on 'not yet'", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 30);
    await snoozeGraduation("a", U);

    const status = await statusOf("a");
    expect(status.graduationSnoozedUntil).toBe(shift(TODAY, 14));
    expect(status.canGraduate).toBe(false);
    expect(status.graduatedAt).toBeUndefined(); // snoozing is not graduating
  });

  it("is a no-op to graduate something already graduated", async () => {
    setGoals({ ...daily("a"), graduatedAt: shift(TODAY, -10), graduatedRun: 99 });
    await graduateGoal("a", U);
    const status = await statusOf("a");
    expect(status.graduatedAt).toBe(shift(TODAY, -10)); // original date and run untouched
    expect(status.graduatedRun).toBe(99);
  });
});

describe("a graduated habit is no longer tracked", () => {
  it("refuses a check-in", async () => {
    setGoals({ ...daily("a"), graduatedAt: shift(TODAY, -3), graduatedRun: 40 });
    await expect(addCheckIn("a", undefined, U)).rejects.toBeInstanceOf(GraduatedGoalError);
  });

  it("refuses a backfill of a past date too", async () => {
    setGoals({ ...daily("a"), graduatedAt: shift(TODAY, -3), graduatedRun: 40 });
    await expect(addCheckIn("a", shift(TODAY, -1), U)).rejects.toBeInstanceOf(GraduatedGoalError);
  });

  it("still accepts check-ins once un-graduated", async () => {
    setGoals(daily("a"));
    seedDailyRun("a", 30);
    await graduateGoal("a", U);
    await ungraduateGoal("a", U);
    await expect(addCheckIn("a", undefined, U)).resolves.toEqual({ count: 1 });
  });
});
