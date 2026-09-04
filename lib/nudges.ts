import type { GoalStatus } from "./types";

// The escalation ladder for one unfinished habit, per day:
//   1-3. three texts, spread evenly from the habit's nudgeTime to DAY_END
//   4.   a phone call at DAY_END
//   5.   a text to the user's accountability partner, PARTNER_ALERT_DELAY_MIN after that call
// Everything here is pure - the weekday, clock, and habit list are passed in - so the dispatch
// route (app/api/nudge/dispatch/route.ts) and the inbound reply matcher
// (app/api/nudge/inbound/route.ts) can share it without either one owning the clock.

export const DEFAULT_NUDGE_TIME = "21:00";

// The moment the texting phase ends and the call goes out. Every habit's third text lands
// before this and the call lands on it, so escalation timing doesn't depend on tick rate.
export const DAY_END = "22:00";

export const NUDGE_TEXT_COUNT = 3;

// How long after the call the user has to finish before their partner is told.
export const PARTNER_ALERT_DELAY_MIN = 30;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Wraps at midnight, which callers must account for: a time that wraps sorts *before* the
// time it was derived from, so a ">= deadline" comparison silently never fires. That's the
// intended outcome for the partner alert (a call placed at 23:50 doesn't spill into tomorrow),
// not an oversight.
export function addMinutes(hhmm: string, minutes: number): string {
  return toHHMM(toMinutes(hhmm) + minutes);
}

// The three text sends for one habit, spread evenly across the span from its nudge time to
// DAY_END. Deriving the times from the habit rather than from the dispatch tick is what
// guarantees exactly three reminders before the call no matter how the habit is configured:
// set to 9am they land 4h20m apart, set to 9pm they land 20 minutes apart.
export function nudgeSlots(nudgeTime?: string, dayEnd: string = DAY_END): string[] {
  const start = toMinutes(nudgeTime ?? DEFAULT_NUDGE_TIME);
  const end = toMinutes(dayEnd);
  // A nudge time at or past the day's end leaves no span to divide. One reminder, no
  // escalation - and in practice the dispatch window has closed by then anyway.
  if (start >= end) return [nudgeTime ?? DEFAULT_NUDGE_TIME];
  const step = (end - start) / NUDGE_TEXT_COUNT;
  return Array.from({ length: NUDGE_TEXT_COUNT }, (_, i) => toHHMM(Math.round(start + i * step)));
}

// Every slot whose time has passed, not just the most recent one. A dispatch outage that skips
// a tick therefore burns the slots it missed rather than replaying them one per later tick,
// which would stretch a habit's three reminders past the call it's supposed to precede.
export function dueSlotIndices(slots: string[], nowHHMM: string): number[] {
  return slots.flatMap((time, i) => (nowHHMM >= time ? [i] : []));
}

// Spoken word-for-word by the escalation call. Habit names only: emoji read badly in
// text-to-speech, coming out either skipped or narrated ("weight lifter, Gym session").
export function callScript(label: string, habitNames: string[]): string {
  const n = habitNames.length;
  const list =
    n > 1 ? `${habitNames.slice(0, -1).join(", ")}, and ${habitNames[n - 1]}` : habitNames[0];
  return (
    `Hey ${label}. This is your accountability check. ` +
    `You still have ${n} habit${n === 1 ? "" : "s"} open today: ${list}. ` +
    `Open the app to check ${n === 1 ? "it" : "them"} off.`
  );
}

// The single source of truth for "is this habit still pending" - the text dispatch, the call,
// the partner alert, and the inbound reply matcher all run off it, so they can't disagree.
export function getPendingNudges(goals: GoalStatus[], todayDow: number, nowHHMM: string): GoalStatus[] {
  return goals.filter((g) => {
    // Graduated habits aren't tracked any more, so they're never pending. (getGoalStatuses
    // already reports them as complete, which would exclude them anyway - this is the explicit
    // statement of why, so the reason survives any change to how a graduated status is shaped.)
    if (g.graduatedAt) return false;

    // A habit doesn't enter the ladder until its configured reminder time has passed for the
    // day - that time is also its first text slot (see nudgeSlots).
    if ((g.nudgeTime ?? DEFAULT_NUDGE_TIME) > nowHHMM) return false;

    if (g.frequency === "daily") {
      return g.nudgeEnabled !== false && g.completedThisPeriod < g.targetCount;
    }
    if (g.nudgeDays && g.nudgeDays.includes(todayDow)) {
      return g.completedThisPeriod < g.targetCount && g.todayCount === 0;
    }
    return false;
  });
}
