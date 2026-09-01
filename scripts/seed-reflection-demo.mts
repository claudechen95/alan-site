// Throwaway E2E fixture for the reflection prompt. Seeds a disposable `reflectdemo` user with
// one goal per prompt variant so /reflectdemo shows all of them at once, then (with `clean`)
// deletes every key it wrote.
// Run: npx tsx --env-file=.env.local scripts/seed-reflection-demo.mts [clean]
import { Redis } from "@upstash/redis";
import { getTodayDate } from "../lib/kv";
import type { Goal } from "../lib/types";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  cache: "no-store",
});

const U = "reflectdemo";
const today = getTodayDate();

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = Mon
const monday = shift(today, -dow);
const weekDay = (i: number) => shift(monday, i);
const lastWeekDay = (i: number) => shift(monday, i - 7);
const daysLeft = 7 - dow;

const goals: Goal[] = [
  { id: "dailymiss", name: "Missed yesterday (required)", emoji: "🥗", frequency: "daily", targetCount: 1, nudgeNumber: 1 },
  { id: "dailyok", name: "Did it yesterday (no prompt)", emoji: "😴", frequency: "daily", targetCount: 1, nudgeNumber: 2 },
  { id: "zeroslack", name: `Zero slack ${daysLeft}x/wk (optional)`, emoji: "🏋️", frequency: "weekly", targetCount: daysLeft, nudgeNumber: 3 },
  { id: "shortweek", name: "Last week 2/3 (required)", emoji: "🎹", frequency: "weekly", targetCount: 3, nudgeNumber: 4 },
  { id: "slack", name: "Plenty of slack (no prompt)", emoji: "🧘", frequency: "weekly", targetCount: 3, nudgeNumber: 5 },
  { id: "eligible", name: "30-day run (offer graduation)", emoji: "💊", frequency: "daily", targetCount: 1, nudgeNumber: 6 },
  { id: "grad1", name: "Already graduated", emoji: "🦷", frequency: "daily", targetCount: 1, nudgeNumber: 7, graduatedAt: shift(today, -20), graduatedRun: 142 },
  { id: "grad2", name: "Also graduated", emoji: "💧", frequency: "weekly", targetCount: 2, nudgeNumber: 8, graduatedAt: shift(today, -5), graduatedRun: 9 },
];

const checkins: Record<string, string[]> = {
  dailymiss: [shift(today, -3)],
  dailyok: [shift(today, -1)],
  zeroslack: [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4), lastWeekDay(5), lastWeekDay(6)],
  shortweek: [lastWeekDay(0), lastWeekDay(1)],
  slack: [lastWeekDay(0), lastWeekDay(2), lastWeekDay(4), weekDay(0)],
  // Yesterday back 30 days: a 30-day run, past the 28-day bar, with today still open.
  eligible: Array.from({ length: 30 }, (_, i) => shift(today, -(i + 1))),
  grad1: [shift(today, -25)],
  grad2: [shift(today, -8)],
};

const keys = [
  `${U}:goals`,
  ...goals.flatMap((g) => [`${U}:history:${g.id}`, `${U}:reflection:${g.id}:${today}`, `${U}:reflection:${g.id}:${shift(today, -1)}`]),
  ...Object.entries(checkins).flatMap(([id, dates]) => dates.map((d) => `${U}:checkin:${id}:${d}`)),
  ...goals.flatMap((g) => Array.from({ length: 40 }, (_, i) => `${U}:checkin:${g.id}:${shift(today, -i)}`)),
];

async function main() {
  if (process.argv[2] === "clean") {
    await kv.del(...new Set(keys));
    console.log(`cleaned ${new Set(keys).size} keys for /${U}`);
    return;
  }

  await kv.del(...new Set(keys));
  await kv.set(`${U}:goals`, goals);
  for (const [id, dates] of Object.entries(checkins)) {
    for (const d of dates) await kv.set(`${U}:checkin:${id}:${d}`, 1);
    await kv.lpush(`${U}:history:${id}`, JSON.stringify({ goalId: id, timestamp: 1, date: dates[0], week: "seed" }));
  }
  console.log(`seeded /${U} — today=${today}, dow=${dow}, daysLeft=${daysLeft}`);
}

main();
