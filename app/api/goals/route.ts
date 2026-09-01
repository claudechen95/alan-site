import { NextResponse } from "next/server";
import {
  getGoals,
  saveGoals,
  getGoalStatuses,
  renumberGoals,
  resolveUser,
  graduateGoal,
  ungraduateGoal,
  snoozeGraduation,
} from "@/lib/kv";

export async function GET(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const statuses = await getGoalStatuses(user);
    return NextResponse.json(statuses);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load goals" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const body = await req.json();
    const goals = await getGoals(user);

    // Add or update a goal
    const existing = goals.findIndex((g) => g.id === body.id);
    if (existing >= 0) {
      goals[existing] = { ...goals[existing], ...body };
    } else {
      goals.push(body);
      renumberGoals(goals); // new goal — assign it the next nudge number
    }
    await saveGoals(goals, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { orderedIds, goalId, graduation } = await req.json();

    // Graduation actions: graduate | ungraduate | snooze, all keyed on a single goal.
    if (goalId && graduation) {
      if (graduation === "graduate") await graduateGoal(goalId, user);
      else if (graduation === "ungraduate") await ungraduateGoal(goalId, user);
      else if (graduation === "snooze") await snoozeGraduation(goalId, user);
      else return NextResponse.json({ error: "Unknown graduation action" }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds required" }, { status: 400 });
    }
    const goals = await getGoals(user);
    (orderedIds as string[]).forEach((id, index) => {
      const goal = goals.find((g) => g.id === id);
      if (goal) goal.order = index;
    });
    await saveGoals(goals, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { id } = await req.json();
    const goals = await getGoals(user);
    const remaining = goals.filter((g) => g.id !== id);
    renumberGoals(remaining); // keep nudge numbers compact after a removal
    await saveGoals(remaining, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete goal" }, { status: 500 });
  }
}
