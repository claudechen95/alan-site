import type { GoalStatus } from "./types";

// Used by the server-side escalating-text dispatch and inbound-reply matching
// (app/api/nudge/dispatch/route.ts, app/api/nudge/inbound/route.ts) so both agree on exactly
// which goals are "still pending" — todayDow/nowHHMM are passed in rather than computed here
// so this stays a pure, environment-agnostic predicate.
export function getPendingNudges(goals: GoalStatus[], todayDow: number, nowHHMM: string): GoalStatus[] {
  return goals.filter((g) => {
    // Graduated habits aren't tracked any more, so they're never pending. (getGoalStatuses
    // already reports them as complete, which would exclude them anyway - this is the explicit
    // statement of why, so the reason survives any change to how a graduated status is shaped.)
    if (g.graduatedAt) return false;

    // A habit doesn't enter the nudge rotation until its configured reminder time has passed
    // for the day — set to 6pm, the earliest possible nudge is the 6pm tick, then hourly after.
    if ((g.nudgeTime ?? "21:00") > nowHHMM) return false;

    if (g.frequency === "daily") {
      return g.nudgeEnabled !== false && g.completedThisPeriod < g.targetCount;
    }
    if (g.nudgeDays && g.nudgeDays.includes(todayDow)) {
      return g.completedThisPeriod < g.targetCount && g.todayCount === 0;
    }
    return false;
  });
}
