import { NextResponse } from "next/server";
import { getGoals, getHistory, getStreak, getReflectionsForGoal, resolveUser } from "@/lib/kv";

export async function GET(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const goals = await getGoals(user);

    const history = await Promise.all(
      goals.map(async (goal) => {
        const periods = 91;
        // A graduated habit stopped being tracked, so recomputing its streak would just show it
        // decaying toward zero. Report the run frozen at graduation instead.
        const [entries, streak] = await Promise.all([
          getHistory(goal, periods, user),
          goal.graduatedAt ? Promise.resolve(goal.graduatedRun ?? 0) : getStreak(goal, user),
        ]);

        // Reflections are now stored by date key for all goal types
        const reflections = await getReflectionsForGoal(goal.id, entries.map((e) => e.period), user);

        return { goal, entries, streak, reflections };
      })
    );

    return NextResponse.json(history);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}
