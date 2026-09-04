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
  getTodayDate,
  getPstTimeHHMM,
  resolveUser,
} from "@/lib/kv";
import {
  getPendingNudges,
  nudgeSlots,
  dueSlotIndices,
  callScript,
  addMinutes,
  DAY_END,
  PARTNER_ALERT_DELAY_MIN,
} from "@/lib/nudges";
import { sendText } from "@/lib/sendblue";
import { isCallConfigured, placeCall } from "@/lib/call";

type Step = "text" | "call" | "partner";

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
      const vacation = await getActiveVacation(uid);
      const pausedIds = new Set(vacation?.goalIds ?? []);
      const goals = (await getGoalStatuses(uid)).filter((g) => !pausedIds.has(g.id));

      // Snoozing is applied per step below, never here: steps 1–4 respect it, step 5 doesn't.
      const pendingAll = getPendingNudges(goals, todayDow, nowHHMM);
      if (pendingAll.length === 0) continue;

      // Step 5, checked first because it's the one step a snooze can't dodge. Replying "stop"
      // silences your own phone; only actually finishing the habit keeps it from your partner.
      const escalatedAt = await getEscalationTime(uid, today);
      if (escalatedAt && nowHHMM >= addMinutes(escalatedAt, PARTNER_ALERT_DELAY_MIN)) {
        if (user.partnerPhone && (await claimPartnerAlert(uid, today))) {
          const names = pendingAll.map((g) => `${g.emoji} ${g.name}`).join(", ");
          await sendText(user.partnerPhone, `📢 ${user.label} didn't finish today: ${names}`);
          results.push({ userId: user.id, step: "partner" });
        }
        continue;
      }

      const snoozedFlags = await Promise.all(pendingAll.map((g) => getNudgeSnoozed(uid, g.id, today)));
      const pending = pendingAll.filter((_, i) => !snoozedFlags[i]);
      const snoozed = pendingAll.filter((_, i) => snoozedFlags[i]);

      // Step 4. Every habit's text slots land before DAY_END, so past this point there is
      // nothing left to text: it's the call or nothing. The escalation is claimed off pendingAll
      // (so a fully-snoozed evening still starts the partner countdown) but only rings a phone
      // if something survived the snooze filter.
      if (nowHHMM >= DAY_END) {
        if (await claimEscalation(uid, today, nowHHMM)) {
          if (pending.length > 0 && isCallConfigured()) {
            await placeCall(user.phone, callScript(user.label, pending.map((g) => g.name)));
            results.push({ userId: user.id, step: "call" });
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
