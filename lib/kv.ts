import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  cache: "no-store",
});
import type { Goal, CheckInRecord, WeeklyNote } from "./types";

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
export async function getRemindHour(): Promise<number> {
  const val = await kv.get<number>("settings:remindHour");
  return val ?? 20; // default 8 PM PST
}

export async function setRemindHour(hour: number): Promise<void> {
  await kv.set("settings:remindHour", hour);
}

// --- Period helpers ---
export function getTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date()); // YYYY-MM-DD in PST/PDT
}

export function getWeekKey(date?: string): string {
  const d = date ? new Date(date + "T12:00:00") : new Date();
  const pstDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(d);
  const local = new Date(pstDate + "T12:00:00");
  // ISO week number (Math.floor to avoid fractional days from T12:00:00)
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
async function getWeeklyDaysCompleted(goalId: string, weekDates: string[]): Promise<number> {
  const counts = await kv.mget<number[]>(...weekDates.map((d) => `checkin:${goalId}:${d}`));
  const fromDaily = counts.filter((c) => (c ?? 0) >= 1).length;
  if (fromDaily > 0) return fromDaily;

  // Legacy fallback: weekly key stored before per-day tracking
  const legacyKey = `checkin:${goalId}:${getWeekKey(weekDates[0])}`;
  const legacy = await kv.get<number>(legacyKey);
  return (legacy ?? 0) >= 1 ? 1 : 0;
}

// Unified: completed count for the current period (days for weekly goals, raw count for daily)
export async function getCompletedThisPeriod(goal: Goal): Promise<number> {
  if (goal.frequency === "daily") {
    return getCheckInsForPeriod(goal.id, getTodayDate());
  }
  return getWeeklyDaysCompleted(goal.id, getWeekDatesForDate(getTodayDate()));
}

// --- Goals ---
export async function getGoals(): Promise<Goal[]> {
  let goals = await kv.get<Goal[]>("goals");
  if (!goals) {
    await kv.set("goals", DEFAULT_GOALS);
    return DEFAULT_GOALS;
  }

  // Migrations applied on read
  let changed = false;

  if (!goals.find((g) => g.id === "sleep")) {
    goals.push({ id: "sleep", name: "7+ hr sleep", emoji: "😴", frequency: "daily", targetCount: 1 });
    changed = true;
  }

  if (changed) await kv.set("goals", goals);
  return goals;
}

export async function saveGoals(goals: Goal[]): Promise<void> {
  await kv.set("goals", goals);
}

// --- Check-in records (individual events with timestamps) ---
export async function getCheckInRecords(goalId: string, limit = 200): Promise<CheckInRecord[]> {
  const raw = await kv.lrange<CheckInRecord>(`history:${goalId}`, 0, limit - 1);
  return raw.sort((a, b) => b.timestamp - a.timestamp);
}

// --- Check-ins ---
export async function getCheckInsForPeriod(
  goalId: string,
  period: string
): Promise<number> {
  const count = await kv.get<number>(`checkin:${goalId}:${period}`);
  return count ?? 0;
}

export async function addCheckIn(goalId: string): Promise<{ count: number }> {
  const goals = await getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");

  // Always store under the daily key so weekly totals can be derived from daily data
  const today = getTodayDate();
  const newCount = await kv.incr(`checkin:${goalId}:${today}`);

  const record: CheckInRecord = {
    goalId,
    timestamp: Date.now(),
    date: today,
    week: getWeekKey(),
  };
  await kv.lpush(`history:${goalId}`, JSON.stringify(record));

  return { count: newCount };
}

export async function undoCheckIn(goalId: string): Promise<{ count: number }> {
  const goals = await getGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");

  const today = getTodayDate();
  const key = `checkin:${goalId}:${today}`;
  const current = (await kv.get<number>(key)) ?? 0;
  if (current <= 0) return { count: 0 };

  const newCount = await kv.decr(key);
  return { count: Math.max(0, newCount) };
}

// --- History ---
export async function getHistory(
  goal: Goal,
  periods: number
): Promise<{ period: string; count: number; done: boolean }[]> {
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

  if (goal.frequency === "daily") {
    const keys = labels.map((label) => `checkin:${goal.id}:${label}`);
    const counts = await kv.mget<number[]>(...keys);
    return labels.map((period, i) => {
      const count = counts[i] ?? 0;
      return { period, count, done: count >= goal.targetCount };
    });
  }

  // Weekly goals: build daily grid from individual check-in records.
  // This correctly handles both old data (stored under weekly keys) and new data,
  // since every check-in pushes a record with an exact date to history:{goalId}.
  const allRecords = await kv.lrange<CheckInRecord>(`history:${goal.id}`, 0, -1);
  const countsByDate: Record<string, number> = {};
  for (const r of allRecords) {
    if (r.date) countsByDate[r.date] = (countsByDate[r.date] ?? 0) + 1;
  }

  return labels.map((period) => {
    const count = countsByDate[period] ?? 0;
    return { period, count, done: count >= 1 };
  });
}

// --- Streak calculation ---
export async function getStreak(goal: Goal): Promise<number> {
  if (goal.frequency === "daily") {
    return getDailyStreak(goal);
  }
  return getWeeklyStreak(goal);
}

async function getDailyStreak(goal: Goal): Promise<number> {
  let streak = 0;
  const today = new Date();

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
    const count = await kv.get<number>(`checkin:${goal.id}:${dateKey}`);
    if ((count ?? 0) >= goal.targetCount) {
      streak++;
    } else {
      // Don't break on today if not yet checked in
      if (i > 0) break;
    }
  }
  return streak;
}

async function getWeeklyStreak(goal: Goal): Promise<number> {
  let streak = 0;
  const todayStr = getTodayDate();

  for (let i = 0; i < 52; i++) {
    const [y, m, d] = todayStr.split("-").map(Number);
    const ref = new Date(Date.UTC(y, m - 1, d - i * 7, 12));
    const refStr = [
      ref.getUTCFullYear(),
      String(ref.getUTCMonth() + 1).padStart(2, "0"),
      String(ref.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const daysCompleted = await getWeeklyDaysCompleted(goal.id, getWeekDatesForDate(refStr));
    if (daysCompleted >= goal.targetCount) {
      streak++;
    } else {
      if (i > 0) break;
    }
  }
  return streak;
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

export async function getWeeklyNote(weekKey: string): Promise<WeeklyNote | null> {
  const note = await kv.get<WeeklyNote>(`note:${weekKey}`);
  return note;
}

export async function getAllWeeklyNotes(limit = 52): Promise<WeeklyNote[]> {
  // Get all keys matching note:*
  const keys = await kv.keys("note:*");
  const notes: WeeklyNote[] = [];
  
  for (const key of keys.slice(0, limit)) {
    const note = await kv.get<WeeklyNote>(key);
    if (note) notes.push(note);
  }
  
  // Sort by week descending (newest first)
  return notes.sort((a, b) => b.week.localeCompare(a.week));
}

export async function saveWeeklyNote(note: Omit<WeeklyNote, "updatedAt">): Promise<void> {
  const fullNote: WeeklyNote = {
    ...note,
    updatedAt: Date.now(),
  };
  await kv.set(`note:${note.week}`, fullNote);
}

export async function deleteWeeklyNote(weekKey: string): Promise<void> {
  await kv.del(`note:${weekKey}`);
}

// Seed initial note for March 23, 2026 week (W13)
export async function seedInitialWeeklyNote(): Promise<void> {
  const weekKey = "2026-W13";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;
  
  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of Mar 24",
    headline: "Setting the Foundation",
    notes: "Identified the biggest levers for discipline. Focus on sleep and nutrition as the foundation for everything else.",
    changes: [
      "🥗 Added: Macro nutrients tracking (daily)",
      "😴 Added: 7+ hr sleep tracking (daily) — biggest lever for discipline",
      "🥤 Adjusted: Protein intake changed from daily to 5x/week to lower burden",
      "✅ Reaffirmed: Lowering burden while maintaining progress IS progress",
    ],
  });
}
