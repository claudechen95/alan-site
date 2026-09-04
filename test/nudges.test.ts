import { describe, it, expect } from "vitest";
import {
  getPendingNudges,
  getNudgeEligible,
  callStartTime,
  nudgeSlots,
  dueSlotIndices,
  callScript,
  addMinutes,
  nextCallTime,
  DAY_END,
  MAX_CALL_ATTEMPTS,
} from "@/lib/nudges";
import type { GoalStatus } from "@/lib/types";

// getPendingNudges is the single source of truth for "is this habit still pending" - the text
// dispatch, the escalation call, the partner alert, and the inbound reply matcher all run off
// it, so they can't disagree. It's pure by design: the weekday and clock are passed in rather
// than read from the environment.

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

// The point of deriving slot times from the habit instead of from the cron tick: every habit
// gets exactly three texts before the call, however early or late it starts.
describe("nudgeSlots", () => {
  it("spreads three texts evenly from the nudge time to the day's end", () => {
    expect(nudgeSlots("09:00")).toEqual(["09:00", "13:20", "17:40"]);
    expect(nudgeSlots("18:00")).toEqual(["18:00", "19:20", "20:40"]);
  });

  it("compresses rather than dropping reminders when the nudge time is late", () => {
    expect(nudgeSlots("21:00")).toEqual(["21:00", "21:20", "21:40"]);
  });

  it("always starts on the nudge time and always finishes before the call", () => {
    for (const start of ["08:00", "11:37", "14:05", "20:59"]) {
      const slots = nudgeSlots(start);
      expect(slots).toHaveLength(3);
      expect(slots[0]).toBe(start);
      expect(slots[2] < DAY_END).toBe(true);
    }
  });

  it("defaults an unset nudge time to 21:00, matching getPendingNudges", () => {
    expect(nudgeSlots(undefined)).toEqual(nudgeSlots("21:00"));
  });

  it("degrades to a single reminder when there's no span left to divide", () => {
    expect(nudgeSlots("22:00")).toEqual(["22:00"]);
    expect(nudgeSlots("23:30")).toEqual(["23:30"]);
  });
});

describe("dueSlotIndices", () => {
  const slots = nudgeSlots("18:00"); // 18:00, 19:20, 20:40

  it("reports nothing before the first slot and one slot at a time after", () => {
    expect(dueSlotIndices(slots, "17:59")).toEqual([]);
    expect(dueSlotIndices(slots, "18:00")).toEqual([0]);
    expect(dueSlotIndices(slots, "19:19")).toEqual([0]);
  });

  // A dispatch outage has to burn the slots it slept through, not replay them one per later
  // tick - that would push a habit's third reminder past the call it's meant to precede.
  it("reports every passed slot at once after an outage", () => {
    expect(dueSlotIndices(slots, "20:45")).toEqual([0, 1, 2]);
  });
});

describe("addMinutes", () => {
  it("advances the clock", () => {
    expect(addMinutes("22:00", 30)).toBe("22:30");
    expect(addMinutes("21:45", 30)).toBe("22:15");
  });

  // Wrapping is what stops a late escalation from texting someone's partner after midnight:
  // the wrapped deadline sorts before every remaining time today, so ">= deadline" never fires.
  it("wraps past midnight", () => {
    expect(addMinutes("23:50", 30)).toBe("00:20");
  });
});

describe("callScript", () => {
  it("reads a single habit in the singular", () => {
    expect(callScript("Alan", ["Salad"])).toContain("1 habit open today: Salad.");
    expect(callScript("Alan", ["Salad"])).toContain("check it off");
  });

  it("reads a list with a spoken 'and' before the last habit", () => {
    const script = callScript("Alan", ["Gym session", "Salad", "7+ hr sleep"]);
    expect(script).toContain("3 habits open today: Gym session, Salad, and 7+ hr sleep.");
    expect(script).toContain("check them off");
  });
});

// Call attempts are scheduled off the previous attempt rather than off a fixed timetable, which
// is the opposite of dueSlotIndices and deliberate: a missed text slot is a reminder lost and
// replaying it late would crowd the call it's meant to precede, whereas a missed call attempt is
// a chance to reach someone that's still worth taking a tick late.
describe("nextCallTime", () => {
  it("puts the first call on the computed start rather than a fixed hour", () => {
    expect(nextCallTime(0, null, "21:50")).toBe("21:50");
  });

  it("spaces retries by the backoff, measured from the last call", () => {
    expect(nextCallTime(1, "21:50", "21:50")).toBe("22:00");
    expect(nextCallTime(2, "22:00", "21:50")).toBe("22:10");
  });

  it("returns null once the attempts are spent, which is what hands over to the partner", () => {
    expect(nextCallTime(MAX_CALL_ATTEMPTS, "22:10", "21:50")).toBeNull();
  });

  it("delays rather than skips when dispatch was down for the scheduled attempt", () => {
    // Back after an outage: the second call goes out 10 minutes after the first actually
    // happened, not at the time it would have had the day run uninterrupted.
    expect(nextCallTime(1, "22:40", "21:50")).toBe("22:50");
  });
});

// The call is meant to read as the consequence of the third text going unanswered, so it's
// scheduled off that text rather than off the wall clock.
describe("callStartTime", () => {
  const habit = (nudgeTime: string) => status({ id: nudgeTime, nudgeTime });

  it("fires one tick after a habit's third text", () => {
    // 21:00 habit texts at 21:00 / 21:20 / 21:40.
    expect(callStartTime([habit("21:00")])).toBe("21:50");
  });

  it("waits for the latest habit, so an early one can't pull the call forward", () => {
    // The 13:25 habit is done texting at 19:08, but calling then would spend all three attempts
    // before the 21:00 habit had sent a single reminder.
    expect(callStartTime([habit("13:25"), habit("21:00")])).toBe("21:50");
  });

  it("never starts later than DAY_END, which keeps the ladder inside the dispatch window", () => {
    // A 21:30 habit's third text lands at 21:50, and 22:00 rather than 22:00+ is the start.
    expect(callStartTime([habit("21:30")])).toBe(DAY_END);
  });

  it("ignores habits configured past DAY_END, which never get three texts at all", () => {
    // A 22:30 habit gets one text, not three, so it has no third text to escalate from - it
    // must not drag every other habit's call out to the cap.
    expect(callStartTime([habit("21:00"), habit("22:30")])).toBe("21:50");
  });

  it("falls back to DAY_END when nothing has a full text schedule", () => {
    expect(callStartTime([habit("22:30")])).toBe(DAY_END);
    expect(callStartTime([])).toBe(DAY_END);
  });
});

// getPendingNudges is getNudgeEligible gated on the clock; the split exists so the call can be
// scheduled against habits that haven't started nudging yet.
describe("getNudgeEligible", () => {
  it("includes a habit whose nudge time hasn't arrived, unlike getPendingNudges", () => {
    const goals = [status({ id: "late", nudgeTime: "21:00" })];
    expect(getNudgeEligible(goals, 3).map((g) => g.id)).toEqual(["late"]);
    expect(getPendingNudges(goals, 3, "18:00")).toEqual([]);
    expect(getPendingNudges(goals, 3, "21:00").map((g) => g.id)).toEqual(["late"]);
  });

  it("still excludes graduated and completed habits", () => {
    const goals = [
      status({ id: "graduated", nudgeTime: "21:00", graduatedAt: "2026-08-01" }),
      status({ id: "done", nudgeTime: "21:00", completedThisPeriod: 1, targetCount: 1 }),
    ];
    expect(getNudgeEligible(goals, 3)).toEqual([]);
  });
});
