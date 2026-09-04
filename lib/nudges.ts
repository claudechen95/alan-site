import type { GoalStatus } from "./types";

// The escalation ladder for one unfinished habit, per day:
//   1-3. three texts, spread evenly from the habit's nudgeTime to DAY_END
//   4.   a phone call at DAY_END
//   5.   a text to the user's accountability partner, PARTNER_ALERT_DELAY_MIN after that call
// Everything here is pure - the weekday, clock, and habit list are passed in - so the dispatch
// route (app/api/nudge/dispatch/route.ts) and the inbound reply matcher
// (app/api/nudge/inbound/route.ts) can share it without either one owning the clock.

export const DEFAULT_NUDGE_TIME = "21:00";

// The latest the call phase may begin, and the boundary nudgeSlots divides the texting span
// toward. Normally the call starts earlier than this - see callStartTime - but with three
// attempts and a partner alert hanging off it, starting any later would run past the dispatch
// window before the ladder finished.
export const DAY_END = "22:00";

// How long after the day's last text before the phone rings. One cron tick: long enough that a
// text can be acted on first, short enough that the escalation still reads as a consequence of
// that text rather than an unrelated event later in the evening.
export const ESCALATION_DELAY_MIN = 10;

export const NUDGE_TEXT_COUNT = 3;

// Step 4 is up to this many calls, not one: a single ring is easy to decline in a meeting, and
// declining is precisely the case the call exists for.
export const MAX_CALL_ATTEMPTS = 3;

// The gap between call attempts. Retries have to land on cron ticks to happen at all, so this is
// quantised to the 10-minute tick rate - a shorter backoff would simply round up to it, and a
// longer one would push the last attempt and the partner alert past the dispatch window's close.
export const CALL_RETRY_MIN = 10;

// How long after the ladder's last call the user has to finish before their partner is told.
export const PARTNER_ALERT_DELAY_MIN = 30;

// When the next call attempt is due, or null once the attempts are spent. Measured from when the
// previous call actually went out rather than from a fixed timetable, so a dispatch outage delays
// the ladder instead of silently burning the attempts it slept through - the opposite of
// dueSlotIndices, because a text slot missed is a reminder lost, while a call attempt missed is
// a chance to reach someone that's still worth taking late.
export function nextCallTime(
  attemptsMade: number,
  lastCallAt: string | null,
  callStart: string
): string | null {
  if (attemptsMade >= MAX_CALL_ATTEMPTS) return null;
  if (attemptsMade === 0 || !lastCallAt) return callStart;
  return addMinutes(lastCallAt, CALL_RETRY_MIN);
}

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

// Everything that will nudge at some point today, whether or not its time has come yet. Split
// out from getPendingNudges because the call has to be scheduled against habits that haven't
// started nudging: an afternoon habit whose three texts finish at 19:40 must not drag the phone
// call forward to 19:50 and spend all three attempts before the 21:00 habits have sent a single
// reminder.
export function getNudgeEligible(goals: GoalStatus[], todayDow: number): GoalStatus[] {
  return goals.filter((g) => {
    // Graduated habits aren't tracked any more, so they're never pending. (getGoalStatuses
    // already reports them as complete, which would exclude them anyway - this is the explicit
    // statement of why, so the reason survives any change to how a graduated status is shaped.)
    if (g.graduatedAt) return false;

    if (g.frequency === "daily") {
      return g.nudgeEnabled !== false && g.completedThisPeriod < g.targetCount;
    }
    if (g.nudgeDays && g.nudgeDays.includes(todayDow)) {
      return g.completedThisPeriod < g.targetCount && g.todayCount === 0;
    }
    return false;
  });
}

// The single source of truth for "is this habit still pending" - the text dispatch, the call,
// the partner alert, and the inbound reply matcher all run off it, so they can't disagree. It's
// the eligible set gated on the clock: a habit doesn't enter the ladder until its configured
// reminder time has passed, which is also its first text slot (see nudgeSlots).
export function getPendingNudges(goals: GoalStatus[], todayDow: number, nowHHMM: string): GoalStatus[] {
  return getNudgeEligible(goals, todayDow).filter(
    (g) => (g.nudgeTime ?? DEFAULT_NUDGE_TIME) <= nowHHMM
  );
}

// When the first call goes out: one tick after the last of the day's habits has sent its third
// text, so a text always gets a chance to be acted on before the phone rings. Computed over the
// *eligible* set rather than the pending one, so the ladder waits for habits that haven't
// started nudging yet.
//
// Habits configured at or past DAY_END are excluded from the maximum: nudgeSlots can't divide a
// span that has already closed, so they get a single text rather than three and would otherwise
// drag the whole escalation to the cap. The cap itself keeps the ladder inside the dispatch
// window - with retries and the partner alert hanging off it, a later start would run out of
// ticks before finishing.
export function callStartTime(eligible: GoalStatus[]): string {
  const thirdTexts = eligible
    .map((g) => nudgeSlots(g.nudgeTime))
    .filter((slots) => slots.length === NUDGE_TEXT_COUNT)
    .map((slots) => slots[slots.length - 1]);

  if (thirdTexts.length === 0) return DAY_END;
  const last = thirdTexts.reduce((a, b) => (b > a ? b : a));
  const start = addMinutes(last, ESCALATION_DELAY_MIN);
  return start > DAY_END ? DAY_END : start;
}
