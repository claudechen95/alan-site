import { NextResponse } from "next/server";
import { getGoals, getCompletedThisPeriod } from "@/lib/kv";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

export async function GET() {
  const topic = process.env.NTFY_ALAN_TOPIC;
  if (!topic) {
    return NextResponse.json({ error: "NTFY_ALAN_TOPIC not set" }, { status: 500 });
  }

  // Deduplicate — only send once per day
  const sentKey = `remind:sent:${getTodayPST()}`;
  const alreadySent = await kv.get(sentKey);
  if (alreadySent) {
    return NextResponse.json({ sent: false, reason: "already sent today" });
  }

  const goals = await getGoals();
  const incomplete = (
    await Promise.all(
      goals
        .filter((goal) => goal.frequency === "daily")
        .map(async (goal) => {
          const completed = await getCompletedThisPeriod(goal);
          return completed < goal.targetCount ? goal : null;
        })
    )
  ).filter(Boolean);

  if (incomplete.length === 0) {
    return NextResponse.json({ sent: false, reason: "all done" });
  }

  const nudgeMessages: Record<string, { title: string; body: string }> = {
    sleep: {
      title: "Still awake?",
      body: "It's 10PM and you haven't logged sleep yet. You know what happens when you don't sleep, Alan. Everything gets worse.",
    },
  };

  const fallback = (g: { emoji: string; name: string }) => ({
    title: "Seriously? Still?",
    body: `${g.emoji} ${g.name} — still not done. What are you even doing with your life, Alan.`,
  });

  for (const goal of incomplete) {
    const msg = nudgeMessages[goal!.id] ?? fallback(goal!);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: msg.title,
        Tags: "face_with_raised_eyebrow",
        Priority: "default",
        "Content-Type": "text/plain",
      },
      body: msg.body,
    });
  }

  // Mark as sent, expire after 25 hours
  await kv.set(sentKey, 1, { ex: 90000 });

  return NextResponse.json({ sent: true, incomplete: incomplete.map((g) => g!.name) });
}
