export interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number; // how many times per period
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

export interface GoalStatus extends Goal {
  completedThisPeriod: number;
  isDone: boolean;
  streak: number;
  todayCount: number;
}
