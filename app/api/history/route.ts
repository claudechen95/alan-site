import { NextResponse } from "next/server";
import { getGoals, getHistory, getCheckInRecords, getStreak } from "@/lib/kv";

export async function GET() {
  try {
    const goals = await getGoals();

    const history = await Promise.all(
      goals.map(async (goal) => {
        const periods = 91; // 13 weeks of daily data for all goals
        const [entries, streak] = await Promise.all([
          getHistory(goal, periods),
          getStreak(goal),
        ]);
        return { goal, entries, streak };
      })
    );

    return NextResponse.json(history);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}
