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
  getNudgeEligible,
  callStartTime,
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

      // The call is scheduled off everything that will nudge today, not just what's nudging
      // right now, so an afternoon habit can't pull the escalation forward past the evening
      // ones - see callStartTime.
      const eligible = getNudgeEligible(goals, todayDow);
      const callStart = callStartTime(eligible);

      const pendingAll = getPendingNudges(goals, todayDow, nowHHMM);
      if (pendingAll.length === 0) continue;

      const snoozedFlags = await Promise.all(pendingAll.map((g) => getNudgeSnoozed(uid, g.id, today)));
      const pending = pendingAll.filter((_, i) => !snoozedFlags[i]);
      const snoozed = pendingAll.filter((_, i) => snoozedFlags[i]);

      // Steps 4 and 5. Every habit's third text has landed by callStart, so past this point
      // there is nothing left to text: it's the call, then the partner, or nothing.
      if (nowHHMM >= callStart) {
        // A pickup ends the day outright - see markCallReached.
        if (await isCallReached(uid, today)) continue;

        // Claimed off pendingAll, not `pending`, so a fully-snoozed evening still starts the
        // countdown that step 5 hangs off even though no call will be placed.
        await claimEscalation(uid, today, nowHHMM);

        const callable = pending.length > 0 && isCallConfigured();
        const attempts = callable ? await getCallAttempts(uid, today, MAX_CALL_ATTEMPTS) : [];
        const last = attempts[attempts.length - 1];

        // Resolve the previous attempt before starting another, so "keep calling" is driven by
        // what actually happened rather than by the clock alone.
        if (last?.sid) {
          const outcome = await getCallOutcome(last.sid);
          if (outcome === "pending") continue; // still ringing; decide on the next tick
          if (outcome === "reached") {
            await markCallReached(uid, today, nowHHMM);
            results.push({ userId: user.id, step: "reached" });
            continue;
          }
        }

        const nextAt = callable ? nextCallTime(attempts.length, last?.at ?? null, callStart) : null;
        if (nextAt && nowHHMM >= nextAt) {
          if (await claimCallAttempt(uid, today, attempts.length, nowHHMM)) {
            const sid = await placeCall(user.phone, callScript(user.label, pending.map((g) => g.name)));
            await recordCallSid(uid, today, attempts.length, nowHHMM, sid);
            results.push({ userId: user.id, step: "call" });
          }
          continue;
        }
        if (nextAt) continue; // attempts remain, just not due yet

        // Step 5: the calls are spent (or were never possible). The countdown runs from the last
        // attempt, falling back to the escalation time when nothing could be dialled at all.
        const base = last?.at ?? (await getEscalationTime(uid, today));
        if (base && nowHHMM >= addMinutes(base, PARTNER_ALERT_DELAY_MIN)) {
          if (user.partnerPhone && (await claimPartnerAlert(uid, today))) {
            // Reported off pendingAll: snoozing mutes your own phone, never your partner's.
            const names = pendingAll.map((g) => `${g.emoji} ${g.name}`).join(", ");
            await sendText(user.partnerPhone, `📢 ${user.label} didn't finish today: ${names}`);
            results.push({ userId: user.id, step: "partner" });
          }
        }
        continue;
      }

      if (pending.length === 0) continue;

      // Steps 1–3. A habit joins this tick's text only if it actually claimed a slot, so a
      // reminder goes out once per slot rather than once per tick.
      const due: typeof pending = [];
      for (const g of pending) {
        const indices = dueSlotIndices(nudgeSlots(g.nudgeTime), nowHHMM);
        const claims = await Promise.all(indices.map((i) => claimNudgeSlot(uid, g.id, today, i)));
        if (claims.some(Boolean)) due.push(g);
      }
      if (due.length === 0) continue;

      const list = due.map((g) => `${g.nudgeNumber}. ${g.emoji} ${g.name}`).join("\n");
      const snoozedLine = snoozed.length > 0
        ? `\nSnoozed today: ${snoozed.map((g) => `${g.emoji} ${g.name}`).join(", ")}`
        : "";
      await sendText(
        user.phone,
        `⏰ Still pending:\n${list}\nReply with a number or habit name to snooze just that one for today, or "stop" to snooze all.${snoozedLine}`
      );
      results.push({ userId: user.id, step: "text" });
    } catch (err) {
      console.error(`Nudge dispatch failed for ${user.id}:`, err);
      // Don't let one user's failure abort the whole batch.
    }
  }

  return NextResponse.json({ results });
}
