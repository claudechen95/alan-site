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

There is no in-app nudge modal anymore — pending goals are surfaced entirely via the escalating text/call ladder (below) for users with a phone number configured. The habit-completion push notification still fires when a user checks off a goal, so their accountability partner sees it:

| User | Completed habit |
|------|----------------|
| Alan | `NTFY_TOPIC` (legacy) |
| Claude | `NTFY_CLAUDE_TOPIC` |
| Rochisha | `NTFY_ROCHISHA_TOPIC` |
| Future | `NTFY_{USER_UPPER}_TOPIC` |

### Escalating nudges (Sendblue + Twilio + cron-job.org)

Any user with a `phone` set (via `/admin`, or `PATCH /api/users`) climbs a five-step ladder each day, per habit, until they complete the check-in.
`lib/nudges.ts` owns the whole schedule and is pure - the clock, weekday, and habit list are passed in - so nothing else computes when a step is due.

`normalizePhone` in `lib/kv.ts` canonicalizes both numbers to E.164 on write, and `findUserByPhone` normalizes both sides of the comparison so numbers stored before it existed still match.
This is load-bearing for inbound replies only: Sendblue and Twilio both parse loose forms like `+1 929 213 7480` on *send*, but Sendblue reports an inbound sender in strict E.164, so a formatted stored number silently matched no user and dropped every snooze.

**Everything in steps 1-4 is scheduled per habit, off that habit's own `nudgeTime`.** The user-level ladder is only step 5.

| Step | When | What |
|------|------|------|
| 1-3 | `nudgeTime`, then evenly spread to `DAY_END` | Text via Sendblue |
| 4 | `habitCallStart` — `ESCALATION_DELAY_MIN` (10 min) after *that habit's* last text — then retried every `CALL_RETRY_MIN` (10 min) up to `MAX_CALL_ATTEMPTS` (3) | Phone call via Twilio |
| 5 | `PARTNER_ALERT_DELAY_MIN` (30 min) after the last call attempt of the day, once no habit has an attempt left | Text to the user's `partnerPhone` |

A 21:00 habit texts at 21:00/21:20/21:40 and calls at 21:50/22:00/22:10; a 13:25 habit texts at 13:25/16:17/19:08 and calls at 19:18/19:28/19:38, on the same evening, without either waiting for the other.
**This means a bad night can be a lot of phone calls** — four habits on four different clocks is up to twelve. In practice answering any one of them sets `nudge:call-reached:{date}` and ends the day for all of them, and so does replying to any text, so twelve is the ignore-everything worst case rather than the normal one.

Two consequences of per-habit calls worth keeping in mind:
- **Texts and calls no longer exclude each other.** The dispatch route used to short-circuit into a single call phase once the clock passed a user-level cutoff, which meant a habit whose `nudgeTime` was past that cutoff (Piano Session at 22:30, Emotional Check-in at 22:00) got neither a text nor a call and went silent all day. There is no cutoff now: a habit can be sending its first text on the same tick another is being called about. Pinned by two regression tests in `nudge-ladder`.
- **Habits due on the same tick share one call.** Dialling the same number twice in one tick would put the second on a busy signal, so `dueCalls` is claimed per habit but placed as a single call naming all of them.

`habitCallStart` is uncapped, so a habit configured past `DAY_END` gets one text (`nudgeSlots` can't divide a closed span) and then its own ladder a tick later, rather than being dropped.

The times come from the *habit*, not from the cron tick: `nudgeSlots(nudgeTime)` divides the span from `nudgeTime` to `DAY_END` into thirds, so a habit always gets exactly three texts before the call.
Set to 9am they land 4h20m apart (9:00, 13:20, 17:40); set to 9pm they land 20 minutes apart (21:00, 21:20, 21:40).
`nudgeTime` defaults to `"21:00"` and the habit form caps it at 21:00, since past that there's no span left to divide.
`getPendingNudges` is the single source of truth for "is this goal pending", and gates a habit out of the ladder entirely until its `nudgeTime` has passed.
Vacation-paused goals (`getActiveVacation`) and graduated goals are excluded.

**Any reply ends the day.** `markReplied` sets `nudge:replied:{date}` on *any* non-empty inbound text, and the dispatch route checks it before reading anything else, so the remaining texts, all call attempts, and the partner alert are all skipped.
The bar is deliberately low - "ok" clears it - on the principle that the escalation exists to reach a person and a reply proves it did, which is the same reason answering the phone (`nudge:call-reached:{date}`, set by `markCallReached`) also ends the ladder.

⚠️ **This makes the per-habit snooze path unreachable.** `nudge:snoozed:{goalId}:{date}` is still written by the inbound route and still read by the dispatch route, but no reply can now set the snooze flag without also setting `nudge:replied`, and the reply check short-circuits first.
So the snooze filtering in `app/api/nudge/dispatch/route.ts`, the "Snoozed today:" line, and the reply-matching that `Goal.nudgeNumber` exists to serve are all effectively dead - `nudgeNumber` survives only to name habits back in the confirmation text.
The older guarantee that **snoozing never silenced your partner** no longer holds either, since the reply that snoozes also ends the day.
This is a consequence of choosing "any reply ends the ladder", not an accident; it is written down here because the code still reads as though the snooze mattered.

- **`app/api/nudge/dispatch/route.ts`** — the tick. Requires header `x-nudge-secret` matching `NUDGE_DISPATCH_SECRET` (rejects with 401 otherwise — there is no unauthenticated path). Scheduled externally via [cron-job.org](https://cron-job.org)'s API (Vercel's Hobby-plan Cron can't run more than once/day, so it can't be used here) — the schedule encodes an **every-10-minutes, 8am–11pm PST** window via `schedule.hours`/`schedule.minutes`/`schedule.timezone`, and sends `x-nudge-secret` as a custom request header. The tick rate itself carries no meaning; it only has to be at least as frequent as the tightest slot spacing (20 min, for a 21:00 habit). Its *end* does matter now that calls are per habit and uncapped: a habit's ladder runs 10, 20 and 30 minutes past its last text, and the partner alert another 30 after that, so a habit configured much past 21:00 can have steps that fall outside the window and simply never fire. A 21:00 habit finishes comfortably (calls 21:50–22:10, partner 22:40); a 22:30 one does not.
- **`lib/call.ts`** — `placeCall` is the only place that talks to a voice provider, the same seam `lib/sendblue.ts` gives texts. Inline TwiML (no hosted callback URL, since the call is one-way, so there's no public webhook to authenticate), `Polly.Matthew`, `loop="2"` because a single pass is easy to miss on pickup, and habit names spoken without emoji, which read badly in TTS. `callScript` in `lib/nudges.ts` builds the spoken text. `isCallConfigured()` gates on the Twilio env vars being present, so an unconfigured deployment just stops the ladder after step 3 instead of erroring every tick.
  **Twilio reports a voicemail pickup as `completed`, exactly like a human answering** — declining a call in a meeting therefore looks identical to taking it, which would make the retry loop stop on the one case it exists for. Two things separate them, neither needing a public webhook: `Timeout: 20` (shorter than the ~25-30s most carriers wait before diverting, so an unanswered call rings out to an honest `no-answer`) and `MachineDetection: "Enable"` (populates `answered_by` for whatever answers fast enough to beat the timeout). `getCallOutcome(sid)` collapses status + `answered_by` into `reached` / `missed` / `pending`, polled on the *following* cron tick rather than pushed to a callback. `unknown` and an absent `answered_by` both count as `reached`: failed detection isn't evidence of a machine, and ringing someone three times because Twilio couldn't classify them is the worse error. AMD also removes the need for a leading `<Pause>`, since detection already withholds the TwiML until the callee is classified.
- **`app/api/nudge/inbound/route.ts`** — Sendblue's inbound-webhook target, registered via `POST https://api.sendblue.com/api/account/webhooks` with a chosen `secret`. Requires that secret to be echoed back (checked against `sb-webhook-secret`/`sb-signing-secret` headers or a `secret` body field — Sendblue's docs don't pin down the exact one, so all are checked; unverified requests always 401). **Any non-empty reply calls `markReplied`, which ends that day's ladder outright** — no further texts, no calls, no partner alert. Sendblue has no reply-to/thread field, so a reply is *also* matched against the sender's currently pending habits by number or name and writes `nudge:snoozed:{goalId}:{date}`, but that no longer changes what gets sent (see the warning above); it survives only so a reply of "2" can be echoed back as "🏋️ Gym" rather than as a bare acknowledgement. The confirmation text deliberately states the whole effect ("Nudges are off for the rest of today") rather than naming just the matched habit, which would read as if the others were still live.
- **`Goal.nudgeNumber`** (`lib/types.ts`) — a stable 1..N id per user, shown in nudge texts ("2. 🏋️ Gym") so a reply like "2" always means the same habit. `renumberGoals()` in `lib/kv.ts` reassigns it compactly whenever a goal is added or deleted (called from `app/api/goals/route.ts`'s `POST`/`DELETE`), and `getGoals()` backfills it for any pre-existing goal missing it. It tracks each goal's storage/creation order, not its drag-reordered display position — a habit's nudge number and its position in the home-screen list can differ.
- Every step claims its slot (`SET NX EX`, all expiring at PST midnight) *before* sending, so overlapping or retried dispatch calls can never double-send: `claimNudgeSlot(userId, goalId, date, slotIndex)` → `nudge:sent:{goalId}:{date}:{slot}` (per goal, so each habit escalates on its own schedule), `claimEscalation` → `nudge:escalated:{date}`, `claimCallAttempt(userId, goalId, date, attempt)` → `nudge:call:{goalId}:{date}:{attempt}` (per goal like the text slots, holding `{at, sid}`, the sid written back once Twilio accepts so the next tick can poll it — habits sharing a merged call share its sid), `claimPartnerAlert` → `nudge:partner-alerted:{date}`.
- `dueSlotIndices` returns *every* passed slot, not just the latest, so a dispatch outage burns the slots it slept through rather than replaying them one per later tick, which would push a habit's third text past the call it's meant to precede.
- `nextCallTime` deliberately does the **opposite**, scheduling each retry off when the previous call actually went out rather than off a fixed timetable — so an outage delays the call ladder instead of burning the attempts it slept through. The asymmetry is intentional: a text slot missed is a reminder lost, and replaying it late would crowd the call it's meant to precede, whereas a call attempt missed is a chance to reach someone that's still worth taking a tick late. It also means the backoff can't compress two attempts into one tick after a gap.
- `lib/sendblue.ts`'s `sendText` is the only place that calls the Sendblue send API.

Env vars: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (chosen by us, used both when registering the webhook and to verify inbound requests), `NUDGE_DISPATCH_SECRET` (chosen by us, given to cron-job.org as a custom header), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

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

**No live Redis.** `test/setup.ts` mocks `@upstash/redis` so every `new Redis(...)` returns the shared in-memory `FakeRedis` from `test/redis-fake.ts`. That fake implements exactly the command surface `lib/kv.ts` uses and preserves the Upstash semantics `kv.ts` depends on (`mget` returns `null` for missing keys, lists are newest-first via `lpush`, and `set` with `nx` returns `null` rather than `"OK"` when the key exists — the nudge ladder's no-double-send guarantee is exactly that return value, so a fake that always said `"OK"` would make a broken dispatch look correct). Add a command to `kv.ts` and the fake needs it too — better a loud failure than a silent `undefined`.

**Time is pinned.** The data-layer suites `vi.setSystemTime` to Wed 26 Aug 2026. That date is deliberate: a Wednesday leaves 5 days in the week, which is the only way to construct both the "still winnable" and "already out of reach" weekly-goal cases. Never write a test that depends on the day it happens to run — an earlier throwaway script did, and its "out of reach" case was unconstructible on Mondays, so it failed every Monday for no real reason.

Suites: `week-keys` (ISO week numbering, incl. a 400-day sweep across both year boundaries and a guard pinning already-stored note keys to their labels), `reflection` (every branch of `getReflectionPrompt`), `graduation` (eligibility, freeze/restore, the untracked guarantees), `nudges` (the pure `getPendingNudges` predicate, plus the escalation schedule: `nudgeSlots`, `dueSlotIndices`, `addMinutes`, `habitCallStart`, `nextCallTime`, `callScript`), `phone` (E.164 canonicalization, incl. the legacy-format inbound match), `nudge-ladder` (the dispatch route end to end), `nudge-inbound` (the Sendblue reply webhook).

`nudge-ladder` is the one suite that drives an API route rather than the data layer.
It replays a whole PST day at the real cron cadence (a POST every 10 simulated minutes, 8am–11pm) with Sendblue and Twilio mocked, and asserts the exact transcript of what went out and when — for its 18:00 habit, `18:00 text`, `19:20 text`, `20:40 text`, `20:50 call`, `21:00 call`, `21:10 call`, `21:40 partner text`.
It also pins the per-habit independence directly: two habits on different clocks run two separate ladders (one being called about while the other is still sending its first text), habits due on the same tick merge into one call, and a habit configured past `DAY_END` still gets both.
The clock is the input under test, so ticks set the system time and let the route read it, rather than passing a time in.
The Twilio mock is a knob for what the *called party* did (`reached`/`missed`/`pending`) rather than a fake of Twilio's HTTP shape, since that outcome is the only thing driving the retry loop.
All three escape hatches are pinned there: replying at all must remove everything remaining including the partner alert, answering the phone must remove the remaining calls and the partner alert, and replaying the same tick ten times must send exactly once.
`nudge-inbound` covers the webhook itself — that the secret gate rejects unverified requests without recording anything, that every shape of reply (a habit name, a bare number, an unmatched "ok") ends the day while an empty message doesn't, and that the confirmation states the full effect.
A `pending` outcome must not consume an attempt — otherwise a slow-to-connect call would silently eat the retries meant to follow it.

`scripts/seed-reflection-demo.mts` is *not* a test — it seeds a disposable `reflectdemo` user against live Redis for manual browser QA of the modals and trophy shelf, which unit tests can't cover. `npx tsx --env-file=.env.local scripts/seed-reflection-demo.mts [clean]`.

## Goals currently tracked (as of June 2026)

**Alan:** Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)

**Rochisha:** Empty — she sets her own goals from scratch at `/rochisha`.
