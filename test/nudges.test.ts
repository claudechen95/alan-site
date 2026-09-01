import { describe, it, expect } from "vitest";
import { getPendingNudges } from "@/lib/nudges";
import type { GoalStatus } from "@/lib/types";

// getPendingNudges is the single source of truth for "is this habit still pending" - both the
// hourly text dispatch and the inbound reply matcher run off it, so they can't disagree. It's
// pure by design: the weekday and clock are passed in rather than read from the environment.

function status(overrides: Partial<GoalStatus> & Pick<GoalStatus, "id">): GoalStatus {
  return {
    name: overrides.id,
    emoji: "x",
    frequency: "daily",
    targetCount: 1,
    completedThisPeriod: 0,
    isDone: false,
    streak: 0,
    todayCount: 0,
    reflection: null,
    canGraduate: false,
    ...overrides,
  } as GoalStatus;
}

const WED = 3;
const ids = (goals: GoalStatus[]) => goals.map((g) => g.id);

describe("getPendingNudges", () => {
  it("holds a habit back until its nudge time has passed", () => {
    const g = status({ id: "a", nudgeTime: "18:00" });
    expect(ids(getPendingNudges([g], WED, "17:59"))).toEqual([]);
    expect(ids(getPendingNudges([g], WED, "18:00"))).toEqual(["a"]);
  });

  it("defaults an unset nudge time to 21:00", () => {
    const g = status({ id: "a" });
    expect(ids(getPendingNudges([g], WED, "20:59"))).toEqual([]);
    expect(ids(getPendingNudges([g], WED, "21:00"))).toEqual(["a"]);
  });

  it("drops a daily habit that has met its target", () => {
    const done = status({ id: "a", completedThisPeriod: 1, targetCount: 1 });
    expect(ids(getPendingNudges([done], WED, "21:00"))).toEqual([]);
  });

  it("respects an explicit opt-out on a daily habit", () => {
    const off = status({ id: "a", nudgeEnabled: false });
    expect(ids(getPendingNudges([off], WED, "21:00"))).toEqual([]);
  });

  it("only nudges a weekly habit on its configured days", () => {
    const g = status({ id: "a", frequency: "weekly", targetCount: 3, nudgeDays: [1, WED] });
    expect(ids(getPendingNudges([g], WED, "21:00"))).toEqual(["a"]);
    expect(ids(getPendingNudges([g], 2, "21:00"))).toEqual([]); // Tuesday isn't in the list
  });

  it("drops a weekly habit already checked in today, even with the week's target unmet", () => {
    const g = status({
      id: "a",
      frequency: "weekly",
      targetCount: 3,
      completedThisPeriod: 1,
      todayCount: 1,
      nudgeDays: [WED],
    });
    expect(ids(getPendingNudges([g], WED, "21:00"))).toEqual([]);
  });

  it("never nudges a graduated habit, which is no longer tracked", () => {
    const g = status({ id: "a", graduatedAt: "2026-08-01", graduatedRun: 40 });
    expect(ids(getPendingNudges([g], WED, "21:00"))).toEqual([]);
  });
});
