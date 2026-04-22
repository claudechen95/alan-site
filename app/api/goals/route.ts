import { NextResponse } from "next/server";
import { getGoals, saveGoals, getCompletedThisPeriod, getStreak, getCheckInsForPeriod, getTodayDate } from "@/lib/kv";
import type { GoalStatus } from "@/lib/types";

export async function GET() {
  try {
    const goals = await getGoals();

    const statuses: GoalStatus[] = await Promise.all(
      goals.map(async (goal) => {
        const completed = await getCompletedThisPeriod(goal);
        const streak = await getStreak(goal);
        const todayCount = await getCheckInsForPeriod(goal.id, getTodayDate());
        return {
          ...goal,
          completedThisPeriod: completed,
          isDone: completed >= goal.targetCount,
          streak,
          todayCount,
        };
      })
    );

    return NextResponse.json(statuses);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load goals" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const goals = await getGoals();

    // Add or update a goal
    const existing = goals.findIndex((g) => g.id === body.id);
    if (existing >= 0) {
      goals[existing] = { ...goals[existing], ...body };
    } else {
      goals.push(body);
    }
    await saveGoals(goals);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    const goals = await getGoals();
    await saveGoals(goals.filter((g) => g.id !== id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete goal" }, { status: 500 });
  }
}
