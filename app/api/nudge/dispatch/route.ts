import { NextResponse } from "next/server";
import {
  getUsers,
  getGoalStatuses,
  getActiveVacation,
  getNudgeSnoozed,
  claimNudgeSlot,
  claimEscalation,
  getEscalationTime,
  claimPartnerAlert,
  claimCallAttempt,
  recordCallSid,
  getCallAttempts,
  markCallReached,
  isCallReached,
  hasReplied,
  getTodayDate,
  getPstTimeHHMM,
  resolveUser,
} from "@/lib/kv";
import {
  getPendingNudges,
  habitCallStart,
  nudgeSlots,
  dueSlotIndices,
  callScript,
  addMinutes,
  nextCallTime,
  MAX_CALL_ATTEMPTS,
  PARTNER_ALERT_DELAY_MIN,
} from "@/lib/nudges";
import { sendText } from "@/lib/sendblue";
import { isCallConfigured, placeCall, getCallOutcome } from "@/lib/call";

type Step = "text" | "call" | "reached" | "partner";

// Triggered every 10 minutes, 8am–11pm PST, by an external cron-job.org schedule (see CLAUDE.md).
// Secured with a plain shared secret rather than a signing scheme since the caller is a plain HTTP
// cron service, not a webhook provider with its own verification SDK.
//
// The tick rate deliberately carries no meaning: what fires is decided by each habit's own slot
// times (lib/nudges.ts), so the ladder is identical whether the cron runs every 10 minutes or
// every 5. Ticking at least as often as the tightest slot spacing is the only real requirement.
export async function POST(req: Request) {
  if (req.headers.get("x-nudge-secret") !== process.env.NUDGE_DISPATCH_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = getTodayDate();
  const todayDow = new Date(today + "T12:00:00").getDay();
  const nowHHMM = getPstTimeHHMM();

  const results: { userId: string; step: Step }[] = [];

  for (const user of await getUsers()) {
    if (!user.phone) continue;
    const uid = resolveUser(user.id);

    try {
      // Any reply at all ends the day - see markReplied. Checked before anything else is read,
      // since it short-circuits every remaining step rather than just one of them.
      if (await hasReplied(uid, today)) continue;

      const vacation = await getActiveVacation(uid);
      const pausedIds = new Set(vacation?.goalIds ?? []);
      const goals = (await getGoalStatuses(uid)).filter((g) => !pausedIds.has(g.id));

      const pendingAll = getPendingNudges(goals, todayDow, nowHHMM);
      if (pendingAll.length === 0) continue;

      // A pickup ends the day outright, for every habit - see markCallReached.
      if (await isCallReached(uid, today)) continue;

      const snoozedFlags = await Promise.all(pendingAll.map((g) => getNudgeSnoozed(uid, g.id, today)));
      const pending = pendingAll.filter((_, i) => !snoozedFlags[i]);
      const snoozed = pendingAll.filter((_, i) => snoozedFlags[i]);

      // Steps 1–3. A habit joins this tick's text only if it actually claimed a slot, so a
      // reminder goes out once per slot rather than once per tick. Texts and calls are both
      // scheduled per habit and no longer exclude each other: a habit that starts nudging late
      // can be sending its first text on the same tick another habit is being called about.
      const dueTexts: typeof pending = [];
      for (const g of pending) {
        const indices = dueSlotIndices(nudgeSlots(g.nudgeTime), nowHHMM);
        const claims = await Promise.all(indices.map((i) => claimNudgeSlot(uid, g.id, today, i)));
        if (claims.some(Boolean)) dueTexts.push(g);
      }

      if (dueTexts.length > 0) {
        const list = dueTexts.map((g) => `${g.nudgeNumber}. ${g.emoji} ${g.name}`).join("\n");
        const snoozedLine = snoozed.length > 0
          ? `\nSnoozed today: ${snoozed.map((g) => `${g.emoji} ${g.name}`).join(", ")}`
          : "";
        await sendText(
          user.phone,
          `⏰ Still pending:\n${list}\nReply with a number or habit name to snooze just that one for today, or "stop" to snooze all.${snoozedLine}`
        );
        results.push({ userId: user.id, step: "text" });
      }

      // Step 4, one ladder per habit, each hanging off its own last text. Resolving the previous
      // attempt happens before any new one is claimed, so "keep calling" is driven by what
      // actually happened rather than by the clock alone.
      const callable = isCallConfigured();
      const dueCalls: { goal: (typeof pending)[number]; attempt: number }[] = [];
      let attemptsRemain = false;
      let lastAttemptAt: string | null = null;
      let reached = false;

      // Walks the pre-snooze list: a snoozed habit still starts the countdown that step 5 hangs
      // off, it just never gets dialled. A fully-snoozed evening therefore still reaches the
      // partner, which is the whole point of the snooze being a mute button rather than an exit.
      const snoozedIds = new Set(snoozed.map((g) => g.id));
      for (const g of pendingAll) {
        const start = habitCallStart(g.nudgeTime);
        if (nowHHMM < start) {
          attemptsRemain = true; // its texts are still running
          continue;
        }
        await claimEscalation(uid, today, nowHHMM);
        if (!callable || snoozedIds.has(g.id)) continue;

        const attempts = await getCallAttempts(uid, g.id, today, MAX_CALL_ATTEMPTS);
        const last = attempts[attempts.length - 1];
        if (last?.at && (!lastAttemptAt || last.at > lastAttemptAt)) lastAttemptAt = last.at;

        if (last?.sid) {
          const outcome = await getCallOutcome(last.sid);
          if (outcome === "reached") {
            reached = true;
            break;
          }
          if (outcome === "pending") {
            attemptsRemain = true; // still ringing; decide on the next tick
            continue;
          }
        }

        const nextAt = nextCallTime(attempts.length, last?.at ?? null, start);
        if (!nextAt) continue; // this habit's attempts are spent
        attemptsRemain = true;
        if (nowHHMM >= nextAt) dueCalls.push({ goal: g, attempt: attempts.length });
      }

      if (reached) {
        await markCallReached(uid, today, nowHHMM);
        results.push({ userId: user.id, step: "reached" });
        continue;
      }

      // Habits due on the same tick share a single call rather than dialling the same number
      // twice over - the second would land on a busy signal, and one call naming both is what
      // the user would want anyway.
      if (dueCalls.length > 0) {
        const claimed = [];
        for (const { goal, attempt } of dueCalls) {
          if (await claimCallAttempt(uid, goal.id, today, attempt, nowHHMM)) {
            claimed.push({ goal, attempt });
          }
        }
        if (claimed.length > 0) {
          const sid = await placeCall(user.phone, callScript(user.label, claimed.map((c) => c.goal.name)));
          await Promise.all(
            claimed.map((c) => recordCallSid(uid, c.goal.id, today, c.attempt, nowHHMM, sid))
          );
          results.push({ userId: user.id, step: "call" });
        }
        continue;
      }

      // Step 5, once no habit has a call attempt left. The countdown runs from the last attempt
      // placed, falling back to the escalation time when nothing could be dialled at all.
      if (attemptsRemain) continue;
      const base = lastAttemptAt ?? (await getEscalationTime(uid, today));
      if (base && nowHHMM >= addMinutes(base, PARTNER_ALERT_DELAY_MIN)) {
        if (user.partnerPhone && (await claimPartnerAlert(uid, today))) {
          // Reported off pendingAll: snoozing mutes your own phone, never your partner's.
          const names = pendingAll.map((g) => `${g.emoji} ${g.name}`).join(", ");
          await sendText(user.partnerPhone, `📢 ${user.label} didn't finish today: ${names}`);
          results.push({ userId: user.id, step: "partner" });
        }
      }
    } catch (err) {
      console.error(`Nudge dispatch failed for ${user.id}:`, err);
      // Don't let one user's failure abort the whole batch.
    }
  }

  return NextResponse.json({ results });
}
