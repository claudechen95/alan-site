export interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number; // how many times per period
  nudgeDays?: number[]; // 0=Sun…6=Sat; weekly goals only
  nudgeTime?: string;  // "HH:MM" PST 24hr, default "21:00"
  nudgeEnabled?: boolean; // daily goals only; opt out of the daily pending-nudge modal, default true
  nudgeNumber?: number; // stable per-user 1..N id shown/used in text nudges, e.g. "reply 2"; renumbered compactly whenever a goal is added or removed
  type?: "mood";
  order?: number;
  streakOffset?: number; // legacy streak days preserved across frequency changes

  // --- Graduation ---
  // A graduated habit is one the user has decided is automatic. The app stops tracking it:
  // no check-ins, no nudges, no reflection prompts, no streak recomputation. It moves to the
  // trophy shelf at the top of the home screen and stays there until manually un-graduated.
  graduatedAt?: string;   // YYYY-MM-DD it was graduated; presence of this is what "graduated" means
  graduatedRun?: number;  // the run it had earned, frozen at graduation: days (daily) or weeks (weekly)
  // "not yet" on a graduation suggestion. Held until this date so a habit the user wants to
  // keep working on doesn't re-ask every single day.
  graduationSnoozedUntil?: string; // YYYY-MM-DD
}

export interface MoodEntry {
  id: string;
  timestamp: number;
  date: string; // YYYY-MM-DD
  emoji: string;
  text: string;
}

export interface CheckInRecord {
  goalId: string;
  timestamp: number;
  date: string; // YYYY-MM-DD
  week: string; // YYYY-WXX
}

export interface WeeklyNote {
  week: string;       // "2026-W13"
  weekLabel: string;  // "Week of Mar 24"
  headline: string;
  notes: string;
  changes: string[];
  updatedAt: number;
}

// Why we're asking for a reflection before the next check-in. Carries the numbers behind the
// call so the prompt can say what actually went wrong instead of a generic "you missed this".
export type ReflectionReason =
  | { reason: "missed-day"; date: string }                                        // daily goal, no check-in yesterday
  | { reason: "week-behind"; completed: number; target: number; daysLeft: number } // weekly goal, out of slack
  | { reason: "week-missed"; completed: number; target: number };                  // weekly goal, last week closed short

export type ReflectionPrompt = ReflectionReason & {
  // Whether the reflection has to be written before the check-in goes through. Required once
  // the period is already lost (nothing left to salvage, so the only useful move is to name
  // what happened); optional while the target is still reachable and the user is, right now,
  // doing the thing we wanted.
  required: boolean;
};

export interface GoalStatus extends Goal {
  completedThisPeriod: number;
  isDone: boolean;
  streak: number;
  todayCount: number;
  reflection: ReflectionPrompt | null;
  // The run is long enough to offer graduation and the user hasn't waved the offer off yet.
  // Always false for an already-graduated habit - there's nothing left to suggest.
  canGraduate: boolean;
}
