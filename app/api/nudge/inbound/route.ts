import { NextResponse } from "next/server";
import {
  findUserByPhone,
  setNudgeSnoozed,
  markReplied,
  getGoalStatuses,
  getActiveVacation,
  getTodayDate,
  getPstTimeHHMM,
  resolveUser,
} from "@/lib/kv";
import { getPendingNudges } from "@/lib/nudges";
import { sendText } from "@/lib/sendblue";

// Sendblue's inbound-message webhook target, registered via POST /api/account/webhooks with
// our own chosen secret (see CLAUDE.md). Sendblue's docs confirm the secret is echoed back in
// a request header but don't name it exactly, so we check the header first and fall back to a
// `secret` field in the JSON body — whichever Sendblue actually uses, an unverified request
// (missing/mismatched on both) is rejected. There is no code path that trusts an unverified
// payload.
function extractSecret(req: Request, body: Record<string, unknown>): string | null {
  return (
    req.headers.get("sb-webhook-secret") ??
    req.headers.get("sb-signing-secret") ??
    (typeof body.secret === "string" ? body.secret : null)
  );
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));
}

// Matches on shared whole words rather than "does the full name appear verbatim" — lets a
// short reply like "video" hit a long habit name like "Video Journal", and avoids a short
// habit name like "Gym" false-matching inside an unrelated word like "gymnastics".
function matchesHabit(reply: string, habitName: string): boolean {
  const replyWords = words(reply);
  return Array.from(words(habitName)).some((w) => replyWords.has(w));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const secret = extractSecret(req, body);
  if (!secret || secret !== process.env.SENDBLUE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (body.is_outbound === false && typeof body.number === "string" && typeof body.content === "string") {
    const user = await findUserByPhone(body.number);
    if (user) {
      const uid = resolveUser(user.id);
      const today = getTodayDate();
      const todayDow = new Date(today + "T12:00:00").getDay();

      const vacation = await getActiveVacation(uid);
      const pausedIds = new Set(vacation?.goalIds ?? []);
      const goals = (await getGoalStatuses(uid)).filter((g) => !pausedIds.has(g.id));
      const pending = getPendingNudges(goals, todayDow, getPstTimeHHMM());

      const reply: string = body.content.trim().toLowerCase();

      // Answering the text ends the day's ladder outright, whatever the answer says. The bar is
      // intentionally low - "ok" clears it - on the view that the escalation exists to reach a
      // person, and a reply is proof it did. Set before the habit matching below, because it
      // applies to every reply and not just the ones that name something.
      if (reply.length > 0) await markReplied(uid, today, getPstTimeHHMM());

      // Sendblue has no reply-to/thread field, so there's no reliable way to know which
      // outbound message a reply is "about" — match the reply text against pending habit
      // names, or a number against each goal's stable nudgeNumber (assigned/renumbered in
      // lib/kv.ts whenever a habit is added or removed, so "2" always means the same habit
      // rather than a position in whichever list happened to go out last).
      //
      // Since markReplied already silences the whole day, this per-habit matching no longer
      // changes what gets sent — it survives only to name the habits back in the confirmation,
      // so a reply of "2" is echoed as the habit it meant rather than as a bare acknowledgement.
      const numbers = (reply.match(/\d+/g) ?? []).map(Number);
      const numberMatches = pending.filter((g) => g.nudgeNumber != null && numbers.includes(g.nudgeNumber)).map((g) => g.id);
      const nameMatches = pending.filter((g) => matchesHabit(reply, g.name)).map((g) => g.id);
      const isExplicitStopAll = /^(stop|all|stop all|snooze all)$/.test(reply);

      const explicit = new Set([...numberMatches, ...nameMatches]);
      const toSnoozeIds = explicit.size > 0 ? Array.from(explicit) : isExplicitStopAll ? pending.map((g) => g.id) : [];

      if (toSnoozeIds.length > 0) {
        await Promise.all(toSnoozeIds.map((id) => setNudgeSnoozed(uid, id, today)));
      }

      // Confirm back so the reply doesn't just vanish into silence — the user has no other way
      // to know it was understood. The message has to state the *whole* effect: naming one
      // habit still ends the day for all of them, so "Snoozed for today: Gym" on its own would
      // read as if the others were still live.
      if (reply.length > 0) {
        const named = pending.filter((g) => toSnoozeIds.includes(g.id)).map((g) => `${g.emoji} ${g.name}`);
        const body_ =
          named.length > 0
            ? `✅ Got it: ${named.join(", ")}. Nudges are off for the rest of today.`
            : `✅ Got it. Nudges are off for the rest of today.`;
        try {
          await sendText(body.number, body_);
        } catch (err) {
          console.error(`Nudge reply confirmation failed for ${user.id}:`, err);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
