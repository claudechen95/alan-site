# Alan & Rochisha's Accountability App — Claude Code Context

Personal habit tracker. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — multi-user by URL path, fully isolated per user.

## Stack
- **Frontend:** `app/page.tsx` (landing page, lists users) + `app/[user]/page.tsx` (per-user tracker)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, vacation, users, nudge/dispatch, nudge/inbound, coach
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Timezone:** Everything PST/PDT (`America/Los_Angeles`). Date strings are `YYYY-MM-DD`.

## Multi-user architecture

Users are identified by URL path (`/alan`, `/rochisha`). All API routes read `?user=` and pass it through the data layer.

**`resolveUser(param)`** in `lib/kv.ts` normalizes the param: `"alan"` and `null`/`""` both map to `undefined` (backward compat — Alan's data has no prefix). Any other value is returned as-is.

**`k(userId, key)`** namespaces Redis keys: `userId ? \`${userId}:${key}\` : key`. So Alan's `goals` key stays `goals`; Rochisha's becomes `rochisha:goals`.

All data is fully isolated: goals, checkins, history, reflections, mood, weekly notes, journal, settings, notification dedup flags.

### Adding a new user

**Option A — Admin UI (no terminal needed):**
Go to `/admin`, fill in user ID + display name, click Add. Topics are generated and stored in Redis automatically. The user appears on the landing page immediately. No deployment, no env vars.

**Option B — Script (from terminal):**
```bash
node scripts/add-user.mjs <id> "<Label>"
# Example:
node scripts/add-user.mjs alice "Alice"
```
Writes directly to Redis. Prints the ntfy subscribe URLs. No deployment needed.

The topic is stored inside the `UserRecord` in Redis (`checkinTopic`). The checkins route resolves it from Redis first, falling back to env vars for Alan/Claude/Rochisha whose topics were set before this system existed.

### Notification env vars per user

There is no in-app nudge modal anymore — pending goals are surfaced entirely via escalating text messages (below) for users with a phone number configured. The habit-completion push notification still fires when a user checks off a goal, so their accountability partner sees it:

| User | Completed habit |
|------|----------------|
| Alan | `NTFY_TOPIC` (legacy) |
| Claude | `NTFY_CLAUDE_TOPIC` |
| Rochisha | `NTFY_ROCHISHA_TOPIC` |
| Future | `NTFY_{USER_UPPER}_TOPIC` |

### Escalating text nudges (Sendblue + cron-job.org)

Any user with a `phone` set (via `/admin`, or `PATCH /api/users`) gets a text via [Sendblue](https://docs.sendblue.com) every hour, 8am–9pm PST, listing whichever habits are still pending — until they either complete the check-in or text back a reply. `lib/nudges.ts`'s `getPendingNudges` is the single source of truth for "is this goal pending". Vacation-paused goals (`getActiveVacation`) are excluded. A habit's `nudgeTime` (set per-goal in the habit form) gates when it *enters* the rotation — e.g. set to 6pm, the earliest possible nudge for that habit is the 6pm tick, then hourly after; it defaults to `"21:00"` if unset.

- **`app/api/nudge/dispatch/route.ts`** — the hourly tick. Requires header `x-nudge-secret` matching `NUDGE_DISPATCH_SECRET` (rejects with 401 otherwise — there is no unauthenticated path). Scheduled externally via [cron-job.org](https://cron-job.org)'s API (Vercel's Hobby-plan Cron can't run more than once/day, so it can't be used here) — the schedule itself encodes the 8am–9pm PST window via `schedule.hours`/`schedule.timezone`, and sends `x-nudge-secret` as a custom request header.
- **`app/api/nudge/inbound/route.ts`** — Sendblue's inbound-webhook target, registered via `POST https://api.sendblue.com/api/account/webhooks` with a chosen `secret`. Requires that secret to be echoed back (checked against `sb-webhook-secret`/`sb-signing-secret` headers or a `secret` body field — Sendblue's docs don't pin down the exact one, so all are checked; unverified requests always 401). Sendblue has no reply-to/thread field, so a reply is matched against the sender's *currently pending* habits by number or name (`nudge:snoozed:{goalId}:{date}`, per-goal) — naming a habit or its `nudgeNumber` snoozes just that one for the rest of the PST day; an explicit "stop"/"all"/"stop all"/"snooze all" reply snoozes everything pending. Anything else (a stray "ok", "on it", etc.) snoozes nothing — silence has to be intentional, not the default outcome of any reply.
- **`Goal.nudgeNumber`** (`lib/types.ts`) — a stable 1..N id per user, shown in nudge texts ("2. 🏋️ Gym") so a reply like "2" always means the same habit. `renumberGoals()` in `lib/kv.ts` reassigns it compactly whenever a goal is added or deleted (called from `app/api/goals/route.ts`'s `POST`/`DELETE`), and `getGoals()` backfills it for any pre-existing goal missing it. It tracks each goal's storage/creation order, not its drag-reordered display position — a habit's nudge number and its position in the home-screen list can differ.
- `lib/kv.ts`'s `claimNudgeSlot(userId, date, hour)` atomically claims (`SET NX EX`) a per-hour send slot *before* texting, so overlapping/retried dispatch calls for the same hour can never double-send.
- `lib/sendblue.ts`'s `sendText` is the only place that calls the Sendblue send API.

Env vars: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (chosen by us, used both when registering the webhook and to verify inbound requests), `NUDGE_DISPATCH_SECRET` (chosen by us, given to cron-job.org as a custom header).

## Data model
Goals are stored as a JSON array at Redis key `goals` (Alan) or `{userId}:goals` (others).

Check-ins are stored per-day: `checkin:{goalId}:{YYYY-MM-DD}` → count. Weekly goals are tracked daily and aggregated — there are NO week-keyed checkin records anymore.

Reflections: `reflection:{goalId}:{YYYY-MM-DD}` → `{ text, savedAt }`. Always date-keyed (not week-keyed), for both daily and weekly goals.

Mood entries: `mood:{YYYY-MM-DD}` → list of `MoodEntry` JSON strings. Also increments `checkin:emotional-checkin:{date}`.

Weekly notes: `note:{YYYY-WXX}` → `WeeklyNote`, keyed by **ISO-8601 week** (Monday-start; week 1 contains Jan 4; the year is the ISO year, so Mon Dec 29 2025 is `2026-W01`). `getWeekKey` in `lib/kv.ts` is the only thing that should compute one - `NotesView`'s client-side `getWeekKeyForDate` mirrors it and must stay in step. Until Aug 2026 `getWeekKey` phased weeks off Jan 4's weekday instead, so in 2026 it returned Sunday–Saturday weeks numbered one below ISO: on Wed Aug 26 it produced `2026-W34`, the key already holding the note labelled "Week of Aug 17", so writing "this week" would have overwritten last week's note. Stored notes were unaffected (their keys and labels were already ISO-correct), so the fix was to `getWeekKey` alone with no data migration. `legacyWeekKey` preserves the old numbering solely to read the two pre-existing `checkin:gym:2026-W1x` keys via the legacy fallback in `getWeeklyDaysCompleted`. Seeded via `seedInitialWeeklyNote()`, `seedWeeklyNoteW22()`, etc., all called in the GET handler of `app/api/notes/route.ts` - only for Alan's namespace (`!user`). Other users start with empty notes.

## Goal schema
```ts
interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number;
  type?: "mood";        // only on emotional-checkin
  order?: number;       // drag-to-reorder position
  nudgeDays?: number[]; // 0=Sun…6=Sat; weekly goals only
  nudgeTime?: string;   // "HH:MM" PST; gates when a habit enters the text-nudge rotation
  nudgeEnabled?: boolean; // daily goals only; opt out of nudging, default true
  nudgeNumber?: number; // stable per-user 1..N id used in nudge texts ("reply 2")
  graduatedAt?: string;   // YYYY-MM-DD; presence = graduated, i.e. no longer tracked at all
  graduatedRun?: number;  // run frozen at graduation: days (daily) or weeks (weekly)
  graduationSnoozedUntil?: string; // YYYY-MM-DD; "not yet" on the graduation offer
}
```

## Key behaviors
- **Goal ordering:** Drag-and-drop via `@dnd-kit`. Done goals always sink to bottom. Order persisted via `PATCH /api/goals` with `{ orderedIds: string[] }`.
- **Reflection prompt:** `getReflectionPrompt()` in `lib/kv.ts` is the single source of truth for whether to ask, why, and whether the user can decline.
  It returns a `ReflectionPrompt` (`lib/types.ts`) on `GoalStatus.reflection`, or `null` for "don't ask"; the client also requires `todayCount === 0`, so a goal prompts at most once a day.
  Daily goals prompt when yesterday had no check-in (`missed-day`).
  Weekly goals are judged against the whole week, not a single day: a 3x/week habit skipped on Tuesday with four days still open is not behind and is not asked anything.
  They prompt only when the days still open no longer outnumber the days still needed (`week-behind`), or when nothing is logged yet this week and last week closed below target (`week-missed`, capped at once per week).
  Vacation-paused days are dropped from the days remaining and prorate the target down, so a partly-paused week can't be "missed" for days the user was never expected to show up.
- **Required vs optional reflections:** `ReflectionPrompt.required` decides whether the reflection can be waved away.
  A period that's already lost - yesterday, a closed-out week, a week whose target is now unreachable - is `required`; a knife's-edge week that's still winnable is not.
  A required prompt drops the "just check in, skip reflection" link and needs `MIN_REFLECTION_CHARS` (15) before the check-in button enables.
  It still closes via ✕ or backdrop, but closing does **not** check the habit in - that's the whole point, since the old skip link handed over the check-in for one tap.
  This is UX friction, not enforcement: `POST /api/checkins` has no server-side gate (no auth, personal app), and backfilling past days from the history grid can still raise a week's count.
- **Emotional Check-in** (`id: "emotional-checkin"`, `type: "mood"`): Opens mood emoji picker. "Log another" instead of "undo" when done. No position pin — user controls via drag.
- **Backfill:** Click a missed (gray/amber) cell in the history grid to log it for that date. `POST /api/checkins` accepts `{ goalId, date }`.
- **Weekly streak for weekly goals:** Counted in weeks, not days. `getWeeklyStreak()` walks back 52 weeks.
- **Graduation:** A habit the user has decided is automatic. `Goal.graduatedAt` (a `YYYY-MM-DD`) is the flag - its presence *is* "graduated", and `graduatedRun` freezes the run it had earned at that moment.
  Graduating **stops tracking entirely**: no check-ins (`addCheckIn` throws `GraduatedGoalError`, which `POST /api/checkins` turns into a 409), no text nudges (`getPendingNudges` filters them out), no reflection prompts (`getReflectionPrompt` returns `null`), and no streak recomputation - `getGoalStatuses` short-circuits to the frozen values instead of hitting Redis, and `app/api/history` reports `graduatedRun` rather than a streak that would only decay.
  The habit leaves the tracked list for a collapsible trophy shelf of emoji medallions at the top of the home screen (`TrophyShelf` in `HabitTracker.tsx`); "start tracking again" on a medallion is the only way back, since there is no automatic un-graduation.
  `getReflectionPrompt` and `getGoalStatuses` both key off `isGraduated()`, so that helper is the single definition.
  **Suggesting it:** `GoalStatus.canGraduate` drives an in-card offer once the run reaches `GRADUATION_PERIODS` (4) consecutive periods at target - 28 days for a daily habit, 4 weeks for a weekly one. Mood goals are never eligible (a journal isn't a habit to master). "not yet" sets `graduationSnoozedUntil` 14 days out; un-graduating sets it too, so a habit just taken off the shelf isn't immediately re-offered.
  All three actions go through `PATCH /api/goals` with `{ goalId, graduation: "graduate" | "ungraduate" | "snooze" }` (the same PATCH also still handles `{ orderedIds }` for drag-reorder).
  Post-graduation days in the history grid are neutral, not misses: `getHistory` marks them `graduated: true`, which drops them from the completion-rate denominator and blocks backfill. `nudgeNumber` is deliberately *not* renumbered on graduation, so a habit's reply number survives a round trip to the shelf and back.
- **Vacation mode:** Per-user, per-habit pause (`VacationWindow { startDate, endDate, goalIds }` in `lib/kv.ts`, key `settings:vacation`). Can be scheduled for a future `startDate`, not just started immediately — `getActiveVacation` only returns a window once `startDate <= today`, so a scheduled-but-not-started window pauses nothing yet; `getUpcomingVacation` surfaces it for display before then. `endVacationNow` trims an active window to end yesterday (preserving vacation-day history) or, for a not-yet-started window, deletes it outright since nothing happened yet to preserve. `startVacation` always replaces any window that hasn't fully ended (active or upcoming) — only one vacation window is tracked "in flight" at a time.

## Coach chat (digital twin)

Per-user chat (`/[user]/coach`, `app/components/CoachView.tsx`) with an LLM persona grounded in transcripts of a personal-development audio program (owned by Alan, ingested for strictly personal/private use — not distributed). Architecture:
- **`lib/vector.ts`** — `searchTranscripts(query, topK)` semantic-searches the ingested transcript chunks via Upstash Vector's hosted-embedding `data` field (no separate embeddings step). The index is **shared with the unrelated `provenance-mcp` project** (same Upstash Vector database/credentials, which live in both repos' `.env.local`) — this app's chunks live in the `coach-transcripts` namespace so they never collide with provenance-mcp's zod-commit vectors in the default namespace.
- **`scripts/ingest-transcripts.mjs`** — one-time/manual script (`node scripts/ingest-transcripts.mjs <folder>`) that walks a folder of `Day N .../*.txt` transcripts, strips timestamp/speaker markup, chunks (~3000 chars, ~300 overlap), and upserts into the `coach-transcripts` namespace with deterministic ids (`day-session-chunkIndex` slug) — safe to re-run.
- **`lib/coach.ts`** — builds the system prompt (persona instructions + retrieved excerpts) and streams a reply via `@anthropic-ai/sdk` (`claude-sonnet-5`).
- **`lib/kv.ts`**'s `CoachMessage`/`getCoachMessages`/`addCoachMessage` — chat history stored the same way as `journal`/`mood` (`rpush`, chronological order), key `coach:chat` / `{userId}:coach:chat`.
- **`app/api/coach/route.ts`** — `GET` returns history; `POST { message, attachments? }` saves the user message, retrieves excerpts, and streams the assistant reply as plain text, persisting the full text once the stream ends.
- **Attachments** — the user can attach text files, images, or PDFs to a single message (paperclip button in `CoachView.tsx`, read client-side via `FileReader`). These are **one-off context for that turn only** — never persisted as files or added to the vector index. Text attachments get appended into the persisted message text (so they naturally stay in later turns' history context); images/PDFs are sent as base64 content blocks (`ChatAttachment` in `lib/coach.ts`) to Claude for that turn only, with just a `[Attached image: ...]`-style marker persisted to history. Server-side caps in `app/api/coach/route.ts`: 5 attachments/message, 50k chars/text file, ~10MB/binary file.
- **Inline citations** — `lib/coach.ts`'s `CITATION_INSTRUCTION` tells the model to cite `(Day — Session)` inline whenever a point is actually drawn from a retrieved excerpt, and to skip citing when it's speaking from general principles or the user's own attached material. `renderBold()` in `CoachView.tsx` renders the `**bold**` markdown the coach's replies use for step/section headers.
- **Retrieval is context-aware, not just the literal last message** — `app/api/coach/route.ts` builds the `searchTranscripts` query from the prior turn's text + the new message (not the new message alone), so short follow-ups like "add your references" or "tell me more" retrieve excerpts about the topic under discussion instead of searching on the follow-up's own (semantically empty) text.
- **`scripts/backfill-coach-citations.mjs`** — one-time/manual script (`node scripts/backfill-coach-citations.mjs [user]`) that retroactively adds citations to assistant replies that predate `CITATION_INSTRUCTION`. Re-derives the original query from each user message (strips the `\n\n--- filename ---`/`\n\n[Attached...]` attachment markers off first), re-runs `searchTranscripts`, and asks Claude to insert citation markers into the *existing* reply text without rewording anything else. Idempotent (skips replies that already have a `(Day N` citation) and non-destructive (`kv.lset` updates one list index in place; skips rather than guesses when nothing in a reply is actually excerpt-grounded).
- Env vars: `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`, `ANTHROPIC_API_KEY` (all currently copied from `provenance-mcp/.env` — see above).

## Migrations (run on every `getGoals()` call)
Add new ones at the bottom of the migration block in `getGoals()`, before `if (changed) await kv.set("goals", goals)`:
- Sleep goal added if missing
- `emotional-checkin` goal added if missing
- Eye ointment: `targetCount` bumped from 5 → 6 if still at 5 (June 2026)
- Salad upgraded from 6x/week to daily, preserving streak as `streakOffset` (June 2026)

Note: migrations in that block are Alan-only (`!userId`). A separate check right after it — `goals.some((g) => g.nudgeNumber == null)` — backfills `Goal.nudgeNumber` and runs for every user, since nudge numbering isn't Alan-specific.

## Adding a weekly note

The seed functions in `lib/kv.ts` are **lazy** — they only run the first time the notes API is hit, so a newly deployed seed won't appear until someone loads the app. To write a note immediately, write directly to Redis with curl.

### Immediate write (preferred)

Figure out the ISO week key first. "Last week" relative to the current date: count back to the Monday of that week, then use `YYYY-Www` format (e.g. Jun 22–28 2026 = `2026-W26`, week of Jun 22 = "Week of Jun 22").

```bash
curl -s -X POST "$UPSTASH_REDIS_REST_URL/set/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(node -e "
const note = {
  week: '2026-W26',
  weekLabel: 'Week of Jun 22',
  headline: 'Short headline here',
  notes: 'Prose summary of the meeting.',
  // The progress log is retired - new notes leave this empty. NoteCard still renders it for
  // notes written before the removal, and NoteForm passes the old lines through on edit so
  // editing an old note doesn't blank its log.
  changes: [],
  updatedAt: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(note));
")"
```

**CRITICAL:** use `process.stdout.write(JSON.stringify(note))` — NOT `console.log(JSON.stringify(JSON.stringify(note)))`. Double-encoding stores a string-of-a-string in Redis; when the app reads it back `note.changes` is `undefined` and the page crashes with `TypeError: Cannot read properties of undefined (reading 'length')`.

Verify the write worked (result should be `dict`, not `str`):
```bash
curl -s "$UPSTASH_REDIS_REST_URL/get/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); v=json.loads(d['result']); print(type(v).__name__, list(v.keys()))"
```

The curl command is all that's needed — no seed functions, no code changes required.

## Dev
```bash
npm run dev        # localhost:3000
npm run deploy     # Vercel deploy via scripts/deploy.sh
npm run verify     # lint + typecheck + test — run this before pushing
npm test           # vitest run
npm run test:watch # vitest in watch mode
```
Env vars needed: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (in `.env.local`).

## Tests

Vitest, in `test/`. `.github/workflows/ci.yml` runs lint → typecheck → test → build on every push to `main` and every PR.

**No live Redis.** `test/setup.ts` mocks `@upstash/redis` so every `new Redis(...)` returns the shared in-memory `FakeRedis` from `test/redis-fake.ts`. That fake implements exactly the command surface `lib/kv.ts` uses and preserves the Upstash semantics `kv.ts` depends on (`mget` returns `null` for missing keys, lists are newest-first via `lpush`). Add a command to `kv.ts` and the fake needs it too — better a loud failure than a silent `undefined`.

**Time is pinned.** The data-layer suites `vi.setSystemTime` to Wed 26 Aug 2026. That date is deliberate: a Wednesday leaves 5 days in the week, which is the only way to construct both the "still winnable" and "already out of reach" weekly-goal cases. Never write a test that depends on the day it happens to run — an earlier throwaway script did, and its "out of reach" case was unconstructible on Mondays, so it failed every Monday for no real reason.

Suites: `week-keys` (ISO week numbering, incl. a 400-day sweep across both year boundaries and a guard pinning already-stored note keys to their labels), `reflection` (every branch of `getReflectionPrompt`), `graduation` (eligibility, freeze/restore, the untracked guarantees), `nudges` (the pure `getPendingNudges` predicate).

`scripts/seed-reflection-demo.mts` is *not* a test — it seeds a disposable `reflectdemo` user against live Redis for manual browser QA of the modals and trophy shelf, which unit tests can't cover. `npx tsx --env-file=.env.local scripts/seed-reflection-demo.mts [clean]`.

## Goals currently tracked (as of June 2026)

**Alan:** Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)

**Rochisha:** Empty — she sets her own goals from scratch at `/rochisha`.
