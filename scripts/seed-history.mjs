import { Redis } from "@upstash/redis";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env.local manually
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const match = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getWeekKey(date) {
  const jan4 = new Date(date.getFullYear(), 0, 4);
  const week = Math.ceil(
    ((date.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7
  );
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

const today = new Date();

// --- Seed protein drink (daily) ---
// Miss ~3 random days in the past 30 to feel realistic
const missedDays = new Set([4, 11, 22]); // indices from today going back

console.log("Seeding protein drink history (daily)...");
for (let i = 30; i >= 1; i--) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  const dateKey = d.toISOString().slice(0, 10);

  if (missedDays.has(i)) {
    console.log(`  ✗ ${dateKey} (skipped)`);
    continue;
  }

  await kv.set(`checkin:protein:${dateKey}`, 1);
  console.log(`  ✓ ${dateKey}`);
}

// --- Seed gym sessions (weekly) ---
// One session per week for past 4 weeks
console.log("\nSeeding gym session history (weekly)...");
const seenWeeks = new Set();
for (let i = 28; i >= 7; i -= 7) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  const weekKey = getWeekKey(d);
  if (seenWeeks.has(weekKey)) continue;
  seenWeeks.add(weekKey);

  await kv.set(`checkin:gym:${weekKey}`, 1);
  console.log(`  ✓ ${weekKey}`);
}

console.log("\nDone! Verifying streaks via API...");

// Verify by reading back a few keys
const proteinToday = await kv.get(`checkin:protein:${today.toISOString().slice(0,10)}`);
const thisWeek = getWeekKey(today);
const gymThisWeek = await kv.get(`checkin:gym:${thisWeek}`);

console.log(`  protein today: ${proteinToday ?? "not checked in yet"}`);
console.log(`  gym this week (${thisWeek}): ${gymThisWeek ?? "not checked in yet"}`);
console.log("\nHistory seeded. Refresh http://localhost:3000 to see streaks.");
