import { Redis } from "@upstash/redis";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

console.log("Scanning for checkin:* and history:* keys...");

let cursor = 0;
const toDelete = [];

do {
  const [nextCursor, keys] = await kv.scan(cursor, { match: "checkin:*", count: 100 });
  toDelete.push(...keys);
  cursor = Number(nextCursor);
} while (cursor !== 0);

cursor = 0;
do {
  const [nextCursor, keys] = await kv.scan(cursor, { match: "history:*", count: 100 });
  toDelete.push(...keys);
  cursor = Number(nextCursor);
} while (cursor !== 0);

if (toDelete.length === 0) {
  console.log("Nothing to delete.");
} else {
  console.log(`Deleting ${toDelete.length} keys...`);
  for (const key of toDelete) {
    await kv.del(key);
    console.log(`  ✗ ${key}`);
  }
  console.log("Done. History cleared.");
}
