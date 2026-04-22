import { NextResponse } from "next/server";
import { addCheckIn, undoCheckIn, getGoals } from "@/lib/kv";

async function sendNotification(goalId: string) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  try {
    const goals = await getGoals();
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return;

    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title": "Alan checked in",
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
    const { goalId } = await req.json();
    const result = await addCheckIn(goalId);
    sendNotification(goalId); // fire-and-forget
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { goalId } = await req.json();
    const result = await undoCheckIn(goalId);
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}
