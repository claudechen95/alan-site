import { NextResponse } from "next/server";
import { addCheckIn, undoCheckIn, getGoals, resolveUser, getNtfyTopic, GraduatedGoalError } from "@/lib/kv";

async function sendNotification(goalId: string, userId?: string) {
  const topic = await getNtfyTopic(userId);
  if (!topic) return;

  try {
    const goals = await getGoals(userId);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return;

    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title": `${userId ? userId.charAt(0).toUpperCase() + userId.slice(1) : "Alan"} checked in`,
        "Tags": "white_check_mark",
        "Content-Type": "text/plain",
      },
      body: `${goal.emoji} ${goal.name} (${goal.frequency})`,
    });
    if (!res.ok) console.warn("ntfy responded:", res.status, await res.text());
  } catch (err) {
    console.warn("Notification failed:", err);
  }
}

export async function POST(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId, date } = await req.json();
    const result = await addCheckIn(goalId, date, user);
    if (!date) sendNotification(goalId, user); // only notify for real-time check-ins
    return NextResponse.json(result);
  } catch (err) {
    // The caller's view of this habit is stale, not broken - it graduated out of tracking.
    if (err instanceof GraduatedGoalError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId } = await req.json();
    const result = await undoCheckIn(goalId, user);
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}
