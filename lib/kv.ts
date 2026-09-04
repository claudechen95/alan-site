import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  cache: "no-store",
});
import type { Goal, GoalStatus, CheckInRecord, WeeklyNote, MoodEntry, ReflectionPrompt } from "./types";

// Normalize the ?user= param: "alan" and empty both map to undefined (un-prefixed namespace).
// Call this in every API route when reading the user query param.
export function resolveUser(param: string | null | undefined): string | undefined {
  if (!param || param === "alan") return undefined;
  return param;
}

// Namespace Redis keys by user. No userId → Alan's existing un-prefixed keys (backward compat).
function k(userId: string | undefined, key: string): string {
  return userId ? `${userId}:${key}` : key;
}

// --- Default goals seeded on first run ---
const DEFAULT_GOALS: Goal[] = [
  {
    id: "gym",
    name: "Gym session",
    emoji: "🏋️",
    frequency: "weekly",
    targetCount: 1,
  },
  {
    id: "protein",
    name: "Protein drink",
    emoji: "🥤",
    frequency: "weekly",
    targetCount: 5,
  },
  {
    id: "sleep",
    name: "7+ hr sleep",
    emoji: "😴",
    frequency: "daily",
    targetCount: 1,
  },
];

// --- Settings ---
export async function getRemindHour(userId?: string): Promise<number> {
  const val = await kv.get<number>(k(userId, "settings:remindHour"));
  return val ?? 20; // default 8 PM PST
}

export async function setRemindHour(hour: number, userId?: string): Promise<void> {
  await kv.set(k(userId, "settings:remindHour"), hour);
}

// --- Vacation mode ---
// Windows are kept forever (not just the active one) so streak walks that later pass back
// over an old vacation window still know to treat those days as neutral, not missed.
export interface VacationWindow {
  startDate: string; // YYYY-MM-DD PST, inclusive
  endDate: string; // YYYY-MM-DD PST, inclusive
  goalIds: string[]; // only these habits are paused by this window
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return [dt.getUTCFullYear(), String(dt.getUTCMonth() + 1).padStart(2, "0"), String(dt.getUTCDate()).padStart(2, "0")].join("-");
}

function isVacationDay(dateStr: string, windows: VacationWindow[], goalId: string): boolean {
  return windows.some((w) => w.goalIds.includes(goalId) && w.startDate <= dateStr && dateStr <= w.endDate);
}

async function getVacationWindows(userId?: string): Promise<VacationWindow[]> {
  const stored = await kv.get<VacationWindow[]>(k(userId, "settings:vacation"));
  return stored ?? [];
}

export async function getActiveVacation(userId?: string): Promise<VacationWindow | null> {
  const today = getTodayDate();
  const windows = await getVacationWindows(userId);
  return windows.find((w) => w.startDate <= today && today <= w.endDate) ?? null;
}

// A window scheduled to start later — not yet in effect, so it doesn't pause anything yet.
export async function getUpcomingVacation(userId?: string): Promise<VacationWindow | null> {
  const today = getTodayDate();
  const windows = await getVacationWindows(userId);
  return windows.filter((w) => w.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null;
}

export async function startVacation(startDate: string, endDate: string, goalIds: string[], userId?: string): Promise<VacationWindow> {
  const today = getTodayDate();
  const windows = await getVacationWindows(userId);
  // Scheduling fresh always replaces any window that hasn't fully ended yet (active or
  // upcoming) — keep only windows that already ended.
  const past = windows.filter((w) => w.endDate < today);
  const window: VacationWindow = { startDate, endDate, goalIds };
  past.push(window);
  await kv.set(k(userId, "settings:vacation"), past);
  return window;
}

// Ends an active vacation early (trims to yesterday, preserving vacation-day history) or
// cancels a not-yet-started scheduled one outright (nothing to preserve — it never began).
export async function endVacationNow(userId?: string): Promise<void> {
  const today = getTodayDate();
  const windows = await getVacationWindows(userId);
  const idx = windows.findIndex((w) => w.startDate <= today && today <= w.endDate);
  if (idx !== -1) {
    // Days already spent on vacation stay tagged vacation; today onward behaves normally again.
    windows[idx] = { ...windows[idx], endDate: addDaysToDateStr(today, -1) };
    await kv.set(k(userId, "settings:vacation"), windows.filter((w) => w.startDate <= w.endDate));
    return;
  }
  const upcomingIdx = windows.findIndex((w) => w.startDate > today);
  if (upcomingIdx !== -1) {
    windows.splice(upcomingIdx, 1);
    await kv.set(k(userId, "settings:vacation"), windows);
  }
}

// --- Escalating text nudges ---
function secondsUntilMidnightPST(): number {
  const now = new Date();
  const pstNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const msSinceMidnight =
    pstNow.getHours() * 3600000 + pstNow.getMinutes() * 60000 + pstNow.getSeconds() * 1000;
  return Math.ceil((86400000 - msSinceMidnight) / 1000);
}

// Snoozed per-goal (not per-user) — a reply naming a specific habit only silences that habit;
// see app/api/nudge/inbound/route.ts for how a reply is matched to the goal(s) it's about.
export async function getNudgeSnoozed(userId: string | undefined, goalId: string, date: string): Promise<boolean> {
  return !!(await kv.get(k(userId, `nudge:snoozed:${goalId}:${date}`)));
}

export async function setNudgeSnoozed(userId: string | undefined, goalId: string, date: string): Promise<void> {
  await kv.set(k(userId, `nudge:snoozed:${goalId}:${date}`), 1, { ex: secondsUntilMidnightPST() });
}

// Atomically claims one of a habit's three text slots for the day (slot times come from
// nudgeSlots in lib/nudges.ts). Returns true if this call claimed it, false if an earlier tick
// already sent that reminder. Claiming BEFORE sending — rather than checking a "last sent"
// timestamp and writing after — means two overlapping or retried dispatch runs can't both pass
// the check. Keyed per goal rather than per user so each habit escalates on its own schedule.
export async function claimNudgeSlot(
  userId: string | undefined,
  goalId: string,
  date: string,
  slotIndex: number
): Promise<boolean> {
  const result = await kv.set(k(userId, `nudge:sent:${goalId}:${date}:${slotIndex}`), 1, {
    nx: true,
    ex: secondsUntilMidnightPST(),
  });
  return result !== null;
}

// Claims the once-a-day moment the ladder runs out of texts, storing the PST time it happened
// so the partner alert can be scheduled relative to the real event rather than a hardcoded hour.
// This is the escalation *step*, not the call: it's claimed even when the call is suppressed
// (everything snoozed) or impossible (no Twilio credentials), because the partner alert hangs
// off this timestamp and must not depend on either.
export async function claimEscalation(
  userId: string | undefined,
  date: string,
  atHHMM: string
): Promise<boolean> {
  const result = await kv.set(k(userId, `nudge:escalated:${date}`), atHHMM, {
    nx: true,
    ex: secondsUntilMidnightPST(),
  });
  return result !== null;
}

export async function getEscalationTime(userId: string | undefined, date: string): Promise<string | null> {
  return await kv.get<string>(k(userId, `nudge:escalated:${date}`));
}

// One record per call attempt (step 4 rings up to MAX_CALL_ATTEMPTS times). `sid` is filled in
// after Twilio accepts the call, so a later tick can ask what became of it; it's absent when the
// claim succeeded but the send then failed.
export interface CallAttempt {
  at: string; // HH:MM PST the attempt went out
  sid?: string;
}

// Claims attempt number `attempt` before dialling, the same before-not-after discipline as
// claimNudgeSlot: two overlapping dispatch runs must not both ring the phone.
export async function claimCallAttempt(
  userId: string | undefined,
  date: string,
  attempt: number,
  atHHMM: string
): Promise<boolean> {
  const result = await kv.set(k(userId, `nudge:call:${date}:${attempt}`), { at: atHHMM }, {
    nx: true,
    ex: secondsUntilMidnightPST(),
  });
  return result !== null;
}

// Safe to overwrite without nx: only the tick that won the claim above ever gets here.
export async function recordCallSid(
  userId: string | undefined,
  date: string,
  attempt: number,
  atHHMM: string,
  sid: string
): Promise<void> {
  await kv.set(k(userId, `nudge:call:${date}:${attempt}`), { at: atHHMM, sid }, {
    ex: secondsUntilMidnightPST(),
  });
}

// The day's attempts so far, oldest first. Reads the whole fixed-size range in one round trip
// and stops at the first gap, so the array length is the attempt count.
export async function getCallAttempts(
  userId: string | undefined,
  date: string,
  maxAttempts: number
): Promise<CallAttempt[]> {
  const keys = Array.from({ length: maxAttempts }, (_, i) => k(userId, `nudge:call:${date}:${i}`));
  const raw = await kv.mget<CallAttempt[]>(...keys);
  const attempts: CallAttempt[] = [];
  for (const entry of raw) {
    if (!entry) break;
    attempts.push(entry);
  }
  return attempts;
}

// Set once a person actually picks up. Unlike a snooze this does end the ladder outright,
// partner alert included - answering is a live acknowledgement, not a mute button.
export async function markCallReached(
  userId: string | undefined,
  date: string,
  atHHMM: string
): Promise<void> {
  await kv.set(k(userId, `nudge:call-reached:${date}`), atHHMM, { ex: secondsUntilMidnightPST() });
}

export async function isCallReached(userId: string | undefined, date: string): Promise<boolean> {
  return !!(await kv.get(k(userId, `nudge:call-reached:${date}`)));
}

// Set by the inbound webhook on *any* reply, and it stops the whole ladder for the day - the
// remaining texts, the calls, and the partner alert. This is a deliberately weak bar: a bare
// "ok" clears it. Answering the text is treated as answering the phone, on the view that the
// nudge's job is to reach a person and a reply proves it did.
export async function markReplied(
  userId: string | undefined,
  date: string,
  atHHMM: string
): Promise<void> {
  await kv.set(k(userId, `nudge:replied:${date}`), atHHMM, { ex: secondsUntilMidnightPST() });
}

export async function hasReplied(userId: string | undefined, date: string): Promise<boolean> {
  return !!(await kv.get(k(userId, `nudge:replied:${date}`)));
}

// Claims the one "your partner didn't finish" text per user per day. Deliberately separate from
// the call claim: the call and the alert fire on different ticks, so one key can't gate both.
export async function claimPartnerAlert(userId: string | undefined, date: string): Promise<boolean> {
  const result = await kv.set(k(userId, `nudge:partner-alerted:${date}`), 1, {
    nx: true,
    ex: secondsUntilMidnightPST(),
  });
  return result !== null;
}

// --- Period helpers ---
export function getTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date()); // YYYY-MM-DD in PST/PDT
}

// "HH:MM" 24hr in PST/PDT, comparable lexicographically against Goal.nudgeTime.
export function getPstTimeHHMM(): string {
  const now = new Date();
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(now);
  const minute = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", minute: "numeric" }).format(now);
  return `${String(Number(hour) % 24).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

// ISO-8601 week key: weeks run Monday–Sunday, and week 1 is the one containing Jan 4. Note the
// year is the *ISO* year, which can differ from the calendar year in late Dec / early Jan -
// Mon Dec 29 2025 is "2026-W01", because it starts the week that contains Jan 4 2026.
//
// This must agree with getWeekDatesForDate (which weekly goals are scored over) and with
// getWeekLabel (which renders a key back into "Week of <Monday>"). Both are already Monday-based
// and anchored on Jan 4, so ISO is the convention that makes all three line up.
export function getWeekKey(date?: string): string {
  const pstDate = date
    ? date
    : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const [y, m, d] = pstDate.split("-").map(Number);

  // Step to the Thursday of this date's week: the ISO year/week are whichever ones own that
  // Thursday, which is what makes the year-boundary cases fall out for free.
  const thursday = new Date(Date.UTC(y, m - 1, d));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const isoYear = thursday.getUTCFullYear();

  // Thursday of ISO week 1 - the week containing Jan 4.
  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() - ((week1Thursday.getUTCDay() + 6) % 7) + 3);

  const week = Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// The pre-ISO week numbering this app used until Aug 2026: weeks were phased off whatever
// weekday Jan 4 landed on, so in 2026 they ran Sunday–Saturday and drifted a week out from the
// Monday-based labels. Kept solely to read back the handful of weekly check-in keys written
// while it was live - data written under a broken scheme still has to be read under it.
function legacyWeekKey(dateStr: string): string {
  const local = new Date(dateStr + "T12:00:00");
  const jan4 = new Date(local.getFullYear(), 0, 4);
  const daysDiff = Math.floor((local.getTime() - jan4.getTime()) / 86400000);
  const week = Math.ceil((daysDiff + jan4.getDay() + 1) / 7);
  return `${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function getPeriodKey(frequency: "daily" | "weekly"): string {
  return frequency === "daily" ? getTodayDate() : getWeekKey();
}

// Returns the 7 YYYY-MM-DD dates (Mon–Sun) for the week containing dateStr
function getWeekDatesForDate(dateStr: string): string[] {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  const dayOfWeek = (ref.getUTCDay() + 6) % 7; // 0=Mon
  ref.setUTCDate(ref.getUTCDate() - dayOfWeek); // rewind to Monday
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(ref);
    day.setUTCDate(ref.getUTCDate() + i);
    return [
      day.getUTCFullYear(),
      String(day.getUTCMonth() + 1).padStart(2, "0"),
      String(day.getUTCDate()).padStart(2, "0"),
    ].join("-");
  });
}

// Count how many days in the given week had ≥1 check-in.
// Falls back to the legacy weekly key (checkin:{id}:{YYYY-WXX}) for data recorded before the
// switch to daily storage, counting it as 1 day if the weekly key has ≥1 check-in.
async function getWeeklyDaysCompleted(goalId: string, weekDates: string[], userId?: string): Promise<number> {
  const counts = await kv.mget<number[]>(...weekDates.map((d) => k(userId, `checkin:${goalId}:${d}`)));
  const fromDaily = counts.filter((c) => (c ?? 0) >= 1).length;
  if (fromDaily > 0) return fromDaily;

  // Legacy fallback: weekly key stored before per-day tracking, under the old week numbering.
  const legacyKey = k(userId, `checkin:${goalId}:${legacyWeekKey(weekDates[0])}`);
  const legacy = await kv.get<number>(legacyKey);
  return (legacy ?? 0) >= 1 ? 1 : 0;
}

// Unified: completed count for the current period (days for weekly goals, raw count for daily)
export async function getCompletedThisPeriod(goal: Goal, userId?: string): Promise<number> {
  if (goal.frequency === "daily") {
    return getCheckInsForPeriod(goal.id, getTodayDate(), userId);
  }
  return getWeeklyDaysCompleted(goal.id, getWeekDatesForDate(getTodayDate()), userId);
}

// Stable per-user 1..N ids used by text nudges ("reply 2") — reassigned compactly by current
// array order whenever a goal is added or removed, so numbers never have gaps.
export function renumberGoals(goals: Goal[]): void {
  goals.forEach((g, i) => {
    g.nudgeNumber = i + 1;
  });
}

// --- Goals ---
export async function getGoals(userId?: string): Promise<Goal[]> {
  let goals = await kv.get<Goal[]>(k(userId, "goals"));
  if (!goals) {
    // Only seed Alan's default goals for his namespace; other users start empty
    if (!userId) {
      await kv.set("goals", DEFAULT_GOALS);
      return DEFAULT_GOALS;
    }
    return [];
  }

  // Migrations — Alan's namespace only
  if (!userId) {
    let changed = false;

    if (!goals.find((g) => g.id === "sleep")) {
      goals.push({ id: "sleep", name: "7+ hr sleep", emoji: "😴", frequency: "daily", targetCount: 1 });
      changed = true;
    }

    if (!goals.find((g) => g.id === "emotional-checkin")) {
      goals.push({
        id: "emotional-checkin",
        name: "Emotional Check-in",
        emoji: "🧠",
        frequency: "daily",
        targetCount: 1,
        type: "mood",
      });
      changed = true;
    }

    // Eye ointment bumped from 5x to 6x/week (June 2026)
    const eyeGoal = goals.find((g) => g.name === "Eye ointment" && g.targetCount === 5);
    if (eyeGoal) {
      eyeGoal.targetCount = 6;
      changed = true;
    }

    // Salad upgraded from 6x/week to daily (June 2026); preserve weekly streak as offset
    const saladGoal = goals.find((g) => g.id === "salad" && g.frequency === "weekly");
    if (saladGoal) {
      const oldWeeklyStreak = await getWeeklyStreak(saladGoal, userId);
      saladGoal.streakOffset = oldWeeklyStreak * 7;
      saladGoal.frequency = "daily";
      saladGoal.targetCount = 1;
      changed = true;
    }

    if (changed) await kv.set(k(userId, "goals"), goals);
  }

  // Backfill nudgeNumber for all users (not just Alan) — runs whenever any goal is missing it,
  // e.g. after the migrations above added a goal, or for pre-existing goals from before this
  // field existed.
  if (goals.some((g) => g.nudgeNumber == null)) {
    renumberGoals(goals);
    await kv.set(k(userId, "goals"), goals);
  }

  return goals;
}

export async function saveGoals(goals: Goal[], userId?: string): Promise<void> {
  await kv.set(k(userId, "goals"), goals);
}

export async function getGoalStatuses(userId?: string): Promise<GoalStatus[]> {
  const goals = await getGoals(userId);
  return Promise.all(
    goals.map(async (goal) => {
      // A graduated habit isn't tracked any more, so there's nothing to recompute - its run was
      // frozen the day it graduated. Reporting it as complete keeps every existing "is this
      // outstanding?" check (nudges, done-filtering) answering "no" without needing to know
      // about graduation at all.
      if (isGraduated(goal)) {
        return {
          ...goal,
          completedThisPeriod: goal.targetCount,
          isDone: true,
          streak: goal.graduatedRun ?? 0,
          todayCount: 0,
          reflection: null,
          canGraduate: false,
        };
      }

      const [completed, streak, todayCount, reflection] = await Promise.all([
        getCompletedThisPeriod(goal, userId),
        getStreak(goal, userId),
        getCheckInsForPeriod(goal.id, getTodayDate(), userId),
        getReflectionPrompt(goal, userId),
      ]);
      return {
        ...goal,
        completedThisPeriod: completed,
        isDone: completed >= goal.targetCount,
        streak,
        todayCount,
        reflection,
        canGraduate: canGraduate(goal, streak),
      };
    })
  );
}

// --- Check-in records (individual events with timestamps) ---
export async function getCheckInRecords(goalId: string, limit = 200, userId?: string): Promise<CheckInRecord[]> {
  const raw = await kv.lrange<CheckInRecord>(k(userId, `history:${goalId}`), 0, limit - 1);
  return raw.sort((a, b) => b.timestamp - a.timestamp);
}

// --- Check-ins ---
export async function getCheckInsForPeriod(
  goalId: string,
  period: string,
  userId?: string
): Promise<number> {
  const count = await kv.get<number>(k(userId, `checkin:${goalId}:${period}`));
  return count ?? 0;
}

export async function addCheckIn(goalId: string, date?: string, userId?: string): Promise<{ count: number }> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");
  // Graduated means untracked, so this is a real error rather than a no-op - the UI never
  // offers the check-in, and the history grid's backfill cells stop at the graduation date.
  // Anything still asking is out of date and should be told so.
  if (isGraduated(goal)) throw new GraduatedGoalError(goalId);

  const targetDate = date || getTodayDate();
  const newCount = await kv.incr(k(userId, `checkin:${goalId}:${targetDate}`));

  const record: CheckInRecord = {
    goalId,
    timestamp: Date.now(),
    date: targetDate,
    week: getWeekKey(targetDate),
  };
  await kv.lpush(k(userId, `history:${goalId}`), JSON.stringify(record));

  return { count: newCount };
}

export async function undoCheckIn(goalId: string, userId?: string): Promise<{ count: number }> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");

  const today = getTodayDate();
  const key = k(userId, `checkin:${goalId}:${today}`);
  const current = (await kv.get<number>(key)) ?? 0;
  if (current <= 0) return { count: 0 };

  const newCount = await kv.decr(key);
  return { count: Math.max(0, newCount) };
}

// --- History ---
export async function getHistory(
  goal: Goal,
  periods: number,
  userId?: string
): Promise<{ period: string; count: number; done: boolean; vacation: boolean; graduated: boolean }[]> {
  const todayPST = getTodayDate();
  const [ty, tm, td] = todayPST.split("-").map(Number);
  const labels: string[] = [];
  for (let i = periods - 1; i >= 0; i--) {
    const utcDate = new Date(Date.UTC(ty, tm - 1, td - i));
    labels.push([
      utcDate.getUTCFullYear(),
      String(utcDate.getUTCMonth() + 1).padStart(2, "0"),
      String(utcDate.getUTCDate()).padStart(2, "0"),
    ].join("-"));
  }

  const keys = labels.map((label) => k(userId, `checkin:${goal.id}:${label}`));
  const [counts, vacationWindows] = await Promise.all([
    kv.mget<number[]>(...keys),
    getVacationWindows(userId),
  ]);
  return labels.map((period, i) => {
    const count = counts[i] ?? 0;
    const done = goal.frequency === "daily" ? count >= goal.targetCount : count >= 1;
    return {
      period,
      count,
      done,
      vacation: isVacationDay(period, vacationWindows, goal.id),
      // Days after graduation aren't misses - nothing was expected on them. The grid renders
      // them as neutral and refuses to backfill them, the same way it treats vacation days.
      graduated: !!goal.graduatedAt && period > goal.graduatedAt,
    };
  });
}

// --- Streak calculation ---
export async function getStreak(goal: Goal, userId?: string): Promise<number> {
  if (goal.frequency === "daily") {
    return getDailyStreak(goal, userId);
  }
  return getWeeklyStreak(goal, userId);
}

async function getDailyStreak(goal: Goal, userId?: string): Promise<number> {
  let streak = 0;
  const today = new Date();
  const vacationWindows = await getVacationWindows(userId);

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
    const count = await kv.get<number>(k(userId, `checkin:${goal.id}:${dateKey}`));
    if ((count ?? 0) >= goal.targetCount) {
      streak++;
    } else if (isVacationDay(dateKey, vacationWindows, goal.id)) {
      continue; // neutral — doesn't break, doesn't count
    } else {
      // Don't break on today if not yet checked in
      if (i > 0) break;
    }
  }
  // Add any streak days preserved from a prior frequency change
  if (streak > 0 && goal.streakOffset) {
    streak += goal.streakOffset;
  }
  return streak;
}

async function getWeeklyStreak(goal: Goal, userId?: string): Promise<number> {
  let streak = 0;
  const todayStr = getTodayDate();
  const vacationWindows = await getVacationWindows(userId);

  for (let i = 0; i < 52; i++) {
    const [y, m, d] = todayStr.split("-").map(Number);
    const ref = new Date(Date.UTC(y, m - 1, d - i * 7, 12));
    const refStr = [
      ref.getUTCFullYear(),
      String(ref.getUTCMonth() + 1).padStart(2, "0"),
      String(ref.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const weekDates = getWeekDatesForDate(refStr);
    const daysCompleted = await getWeeklyDaysCompleted(goal.id, weekDates, userId);
    if (daysCompleted >= goal.targetCount) {
      streak++;
    } else if (weekDates.some((wd) => isVacationDay(wd, vacationWindows, goal.id))) {
      continue;
    } else {
      if (i > 0) break;
    }
  }
  return streak;
}

// --- Graduation ---

// How many consecutive periods at target before we offer to graduate a habit. A weekly habit's
// period is a week, a daily habit's is a day - so this is 4 weeks either way, which is long
// enough to mean something without being unreachable.
const GRADUATION_PERIODS = 4;

// How long "not yet" holds. Two weeks, not one: the user has just told us they still want to
// work on this, and re-asking every few days turns an achievement into nagging.
const GRADUATION_SNOOZE_DAYS = 14;

// The run (in the units getStreak returns - days for daily, weeks for weekly) that makes a
// habit eligible.
function graduationThreshold(goal: Goal): number {
  return goal.frequency === "daily" ? GRADUATION_PERIODS * 7 : GRADUATION_PERIODS;
}

export function isGraduated(goal: Goal): boolean {
  return !!goal.graduatedAt;
}

// Thrown when something tries to check in a habit that has graduated. Its own type so the API
// layer can answer 409 (your view of this habit is stale) rather than 500 (we broke).
export class GraduatedGoalError extends Error {
  constructor(goalId: string) {
    super(`Goal "${goalId}" has graduated and is no longer tracked`);
    this.name = "GraduatedGoalError";
  }
}

// Whether to offer graduation, given a run we've already computed. Mood logging is excluded:
// it's a journal, not a habit to master, so "you've got this one down" is meaningless for it.
function canGraduate(goal: Goal, streak: number): boolean {
  if (isGraduated(goal) || goal.type === "mood") return false;
  if (streak < graduationThreshold(goal)) return false;
  return !goal.graduationSnoozedUntil || goal.graduationSnoozedUntil <= getTodayDate();
}

// Freeze the habit's current run onto the goal and stop tracking it. The run is captured here,
// at the one moment it's still computable - after this the check-ins stop, so recomputing it
// later would only ever show it decaying.
export async function graduateGoal(goalId: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal || isGraduated(goal)) return;

  goal.graduatedAt = getTodayDate();
  goal.graduatedRun = await getStreak(goal, userId);
  delete goal.graduationSnoozedUntil;
  await saveGoals(goals, userId);
}

// Put a graduated habit back into active tracking. The frozen run is dropped rather than
// restored as a streak: the habit hasn't been tracked since it graduated, so its real current
// streak is whatever the check-ins say, which is what getStreak will now go and work out.
export async function ungraduateGoal(goalId: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal || !isGraduated(goal)) return;

  delete goal.graduatedAt;
  delete goal.graduatedRun;
  // Don't immediately re-offer graduation to a habit the user just took back off the shelf.
  goal.graduationSnoozedUntil = addDaysToDateStr(getTodayDate(), GRADUATION_SNOOZE_DAYS);
  await saveGoals(goals, userId);
}

export async function snoozeGraduation(goalId: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.graduationSnoozedUntil = addDaysToDateStr(getTodayDate(), GRADUATION_SNOOZE_DAYS);
  await saveGoals(goals, userId);
}

// --- Missed period detection ---

function getYesterdayDateStr(): string {
  return addDaysToDateStr(getTodayDate(), -1);
}

// The date a reflection is filed under. A daily goal's reflection is about the day it was
// skipped (yesterday); a weekly goal's is about the week as a whole, so it's filed under the
// day it was written.
export function getReflectionDateKey(goal: Goal): string {
  return goal.frequency === "daily" ? getYesterdayDateStr() : getTodayDate();
}

/**
 * Whether to ask for a reflection before this goal's next check-in - and why.
 *
 * Daily goals: every day is expected, so a day with no check-in is a real miss.
 *
 * Weekly goals (e.g. 3x/week): a single skipped day is not a miss. The target is measured
 * across the whole week, so skipping Tuesday with four days still open costs nothing and
 * doesn't warrant a prompt. We only ask once the miss actually threatens the target:
 *   - `week-behind` - the days still open this week no longer outnumber the days still
 *     needed, so the target is either on a knife's edge (every remaining day must land) or
 *     already out of reach.
 *   - `week-missed` - last week closed below target. Caught on the first check-in of the new
 *     week, which also caps this to once per week. Without it, a week that quietly ends short
 *     would never be reflected on at all, since the user stops checking in before the
 *     knife's-edge day arrives.
 *
 * Vacation-paused days are neither available nor expected: they're dropped from the days
 * remaining, and the target is prorated down so a partly-paused week can't be "missed" for
 * days the user was never asked to show up on.
 *
 * `required` marks the prompts the user can't wave away. A period that's already gone -
 * yesterday, a closed-out week, a week whose target is now unreachable - can only be learned
 * from, so writing something is the price of the next check-in. A knife's-edge week is still
 * winnable and the user is checking in as we ask, so that one stays optional; charging them
 * for good behavior is how a prompt turns into noise people click through.
 */
export async function getReflectionPrompt(goal: Goal, userId?: string): Promise<ReflectionPrompt | null> {
  // A graduated habit has no expectations attached to it any more, so it can't be behind on one.
  if (isGraduated(goal)) return null;

  const hasHistory = (await kv.llen(k(userId, `history:${goal.id}`))) > 0;
  if (!hasHistory) return null;

  const vacationWindows = await getVacationWindows(userId);
  const paused = (date: string) => isVacationDay(date, vacationWindows, goal.id);

  if (goal.frequency === "daily") {
    const yesterday = getYesterdayDateStr();
    if (paused(yesterday)) return null;
    const count = await getCheckInsForPeriod(goal.id, yesterday, userId);
    return count === 0 ? { reason: "missed-day", date: yesterday, required: true } : null;
  }

  const today = getTodayDate();
  const weekDates = getWeekDatesForDate(today);
  const completed = await getWeeklyDaysCompleted(goal.id, weekDates, userId);
  const target = Math.min(goal.targetCount, weekDates.filter((d) => !paused(d)).length);
  const daysLeft = weekDates.filter((d) => d >= today && !paused(d)).length;
  const needed = target - completed;
  if (needed > 0 && needed >= daysLeft) {
    // Still winnable if every remaining day lands; only forced once it can't be.
    return { reason: "week-behind", completed, target, daysLeft, required: needed > daysLeft };
  }

  // Nothing logged yet this week, so this is the first check-in since last week closed out.
  if (completed === 0) {
    const lastWeekDates = getWeekDatesForDate(addDaysToDateStr(today, -7));
    const lastTarget = Math.min(goal.targetCount, lastWeekDates.filter((d) => !paused(d)).length);
    if (lastTarget === 0) return null;
    const lastCompleted = await getWeeklyDaysCompleted(goal.id, lastWeekDates, userId);
    if (lastCompleted < lastTarget) {
      return { reason: "week-missed", completed: lastCompleted, target: lastTarget, required: true };
    }
  }

  return null;
}

export async function getReflectionsForGoal(
  goalId: string,
  periodKeys: string[],
  userId?: string
): Promise<Record<string, string>> {
  if (periodKeys.length === 0) return {};
  const values = (await kv.mget(
    ...periodKeys.map((pk) => k(userId, `reflection:${goalId}:${pk}`))
  )) as ({ text: string; savedAt: number } | null)[];
  const result: Record<string, string> = {};
  periodKeys.forEach((pk, i) => {
    const val = values[i];
    if (val?.text) result[pk] = val.text;
  });
  return result;
}

// --- Reflections ---

export async function saveReflection(goalId: string, text: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return;
  const periodKey = getReflectionDateKey(goal);
  await kv.set(k(userId, `reflection:${goalId}:${periodKey}`), { text, savedAt: Date.now() });
}

// --- Weekly Notes ---

export function getCurrentWeekKey(): string {
  return getWeekKey();
}

export function getWeekLabel(weekKey?: string): string {
  // weekKey format: "2026-W13"
  const [year, weekStr] = (weekKey || getWeekKey()).split("-W");
  const week = parseInt(weekStr, 10);

  // Calculate the Monday of that week
  const jan4 = new Date(parseInt(year), 0, 4);
  const daysToMonday = (jan4.getDay() + 6) % 7;
  const firstMonday = new Date(jan4);
  firstMonday.setDate(jan4.getDate() - daysToMonday);

  const targetMonday = new Date(firstMonday);
  targetMonday.setDate(firstMonday.getDate() + (week - 1) * 7);

  const monthLabel = targetMonday.toLocaleDateString("en-US", { month: "short" });
  const dayLabel = targetMonday.getDate();

  return `Week of ${monthLabel} ${dayLabel}`;
}

export async function getWeeklyNote(weekKey: string, userId?: string): Promise<WeeklyNote | null> {
  const note = await kv.get<WeeklyNote>(k(userId, `note:${weekKey}`));
  return note;
}

export async function getAllWeeklyNotes(limit = 52, userId?: string): Promise<WeeklyNote[]> {
  const prefix = userId ? `${userId}:note:` : "note:";
  const keys = await kv.keys(`${prefix}*`);
  const notes: WeeklyNote[] = [];

  for (const key of keys.slice(0, limit)) {
    const note = await kv.get<WeeklyNote>(key);
    if (note) notes.push(note);
  }

  // Sort by week descending (newest first)
  return notes.sort((a, b) => b.week.localeCompare(a.week));
}

export async function saveWeeklyNote(note: Omit<WeeklyNote, "updatedAt">, userId?: string): Promise<void> {
  const fullNote: WeeklyNote = {
    ...note,
    updatedAt: Date.now(),
  };
  await kv.set(k(userId, `note:${note.week}`), fullNote);
}

export async function deleteWeeklyNote(weekKey: string, userId?: string): Promise<void> {
  await kv.del(k(userId, `note:${weekKey}`));
}

// --- Mood / Emotional Check-in ---

export async function addMoodEntry(emoji: string, text: string, userId?: string): Promise<void> {
  const today = getTodayDate();
  const entry: MoodEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    date: today,
    emoji,
    text,
  };
  await kv.rpush(k(userId, `mood:${today}`), JSON.stringify(entry));
  await kv.incr(k(userId, `checkin:emotional-checkin:${today}`));
  const historyRecord: CheckInRecord = {
    goalId: "emotional-checkin",
    timestamp: entry.timestamp,
    date: today,
    week: getWeekKey(today),
  };
  await kv.lpush(k(userId, `history:emotional-checkin`), JSON.stringify(historyRecord));
}

export async function getMoodEntries(date: string, userId?: string): Promise<MoodEntry[]> {
  const raw = await kv.lrange<string | MoodEntry>(k(userId, `mood:${date}`), 0, -1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function deleteMoodEntry(date: string, id: string, userId?: string): Promise<void> {
  const raw = await kv.lrange<string | MoodEntry>(k(userId, `mood:${date}`), 0, -1);
  for (const item of raw) {
    const entry: MoodEntry = typeof item === "string" ? JSON.parse(item) : item;
    if (entry.id === id) {
      // lrem removes all list elements equal to this value
      await kv.lrem(k(userId, `mood:${date}`), 1, item);
      // Decrement the habit completion count for that day
      const key = k(userId, `checkin:emotional-checkin:${date}`);
      const current = (await kv.get<number>(key)) ?? 0;
      if (current > 0) await kv.decr(key);
      return;
    }
  }
}

export async function getAllMoodEntries(limit = 90, userId?: string): Promise<MoodEntry[]> {
  const prefix = userId ? `${userId}:mood:` : "mood:";
  const keys = await kv.keys(`${prefix}*`);
  if (keys.length === 0) return [];
  const sorted = keys
    .map((key) => key.replace(prefix, ""))
    .sort()
    .reverse()
    .slice(0, limit);
  const all: MoodEntry[] = [];
  for (const date of sorted) {
    const entries = await getMoodEntries(date, userId);
    all.push(...entries);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  text: string;
}

export async function addJournalEntry(text: string, userId?: string): Promise<void> {
  const entry: JournalEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    text,
  };
  await kv.lpush(k(userId, "journal"), JSON.stringify(entry));
}

export async function getJournalEntries(limit = 100, userId?: string): Promise<JournalEntry[]> {
  const raw = await kv.lrange<string | JournalEntry>(k(userId, "journal"), 0, limit - 1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function deleteJournalEntry(id: string, userId?: string): Promise<void> {
  const raw = await kv.lrange<string | JournalEntry>(k(userId, "journal"), 0, -1);
  for (const item of raw) {
    const entry: JournalEntry = typeof item === "string" ? JSON.parse(item) : item;
    if (entry.id === id) {
      await kv.lrem(k(userId, "journal"), 1, item);
      return;
    }
  }
}

// --- Coach chat ---

export interface CoachMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export async function getCoachMessages(userId?: string, limit = 100): Promise<CoachMessage[]> {
  const raw = await kv.lrange<string | CoachMessage>(k(userId, "coach:chat"), -limit, -1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function addCoachMessage(
  role: "user" | "assistant",
  text: string,
  userId?: string
): Promise<CoachMessage> {
  const message: CoachMessage = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    timestamp: Date.now(),
  };
  await kv.rpush(k(userId, "coach:chat"), JSON.stringify(message));
  return message;
}

// --- User registry ---

export interface UserRecord {
  id: string;
  label: string;
  checkinTopic?: string; // ntfy topic for habit completions
  phone?: string; // E.164 number for escalating text nudges (Sendblue) and the escalation call
  partnerPhone?: string; // E.164 number told when the ladder runs out (see lib/nudges.ts)
}

const DEFAULT_USERS: UserRecord[] = [
  { id: "alan", label: "Alan" },
  { id: "claude", label: "Claude" },
  { id: "rochisha", label: "Rochisha" },
];

export async function getUsers(): Promise<UserRecord[]> {
  const stored = await kv.get<UserRecord[]>("users");
  if (stored && stored.length > 0) return stored;
  await kv.set("users", DEFAULT_USERS);
  return DEFAULT_USERS;
}

export async function addUser(
  id: string,
  label: string,
  checkinTopic?: string,
  phone?: string
): Promise<void> {
  const users = await getUsers();
  if (users.find((u) => u.id === id)) return;
  users.push({ id, label, checkinTopic, phone: phone ? normalizePhone(phone) : undefined });
  await kv.set("users", users);
}

export async function removeUser(id: string): Promise<void> {
  const users = await getUsers();
  await kv.set("users", users.filter((u) => u.id !== id));
}

// Numbers are typed by hand into /admin, so "+1 929 213 7480" and "(929) 213-7480" both arrive
// meaning the same phone. Sendblue and Twilio each accept those loose forms on send, which hides
// the problem until an inbound reply - Sendblue reports the sender in strict E.164, so a stored
// number that isn't already E.164 matches nothing and the snooze is silently dropped. Normalizing
// on write keeps storage canonical; findUserByPhone normalizes both sides anyway, so numbers
// stored before this still match.
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  // A bare 10-digit US number is the common /admin typo; anything else is assumed to already
  // carry its country code.
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export async function setUserPhone(id: string, phone: string): Promise<void> {
  const users = await getUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.phone = normalizePhone(phone) || undefined;
  await kv.set("users", users);
}

export async function setUserPartnerPhone(id: string, phone: string): Promise<void> {
  const users = await getUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.partnerPhone = normalizePhone(phone) || undefined;
  await kv.set("users", users);
}

// Finds the UserRecord whose phone number matches an inbound text's sender number.
export async function findUserByPhone(phone: string): Promise<UserRecord | undefined> {
  const users = await getUsers();
  const target = normalizePhone(phone);
  return users.find((u) => u.phone && normalizePhone(u.phone) === target);
}

// Resolve ntfy topic for habit-completion notifications: checks Redis UserRecord first,
// falls back to env vars for existing users whose topics were set before the admin UI.
export async function getNtfyTopic(userId: string | undefined): Promise<string | null> {
  const users = await getUsers();
  const user = users.find((u) => u.id === (userId ?? "alan"));
  if (user?.checkinTopic) return user.checkinTopic;

  const upper = (userId ?? "").toUpperCase();
  return process.env[userId ? `NTFY_${upper}_TOPIC` : "NTFY_TOPIC"] ?? process.env.NTFY_TOPIC ?? null;
}
