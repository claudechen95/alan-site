// The escalation call, step 4 of the nudge ladder (see lib/nudges.ts). Twilio is the only voice
// provider we talk to, and this is the only place we talk to it - the same seam lib/sendblue.ts
// gives texts - so swapping providers touches nothing else.

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

// Calls are opt-in by deployment: without credentials the ladder simply stops after the three
// texts rather than erroring on every tick.
export function isCallConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
  );
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

// The spoken message is built from user-authored habit names, so it has to be escaped before
// being interpolated into TwiML - an unescaped "&" or "<" in a habit name is malformed XML and
// Twilio rejects the whole call.
function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => XML_ESCAPES[c]);
}

function authHeader(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  return `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString("base64")}`;
}

// How long the phone rings before Twilio gives up. Deliberately shorter than Twilio's 60s
// default and shorter than the ~25-30s most carriers wait before diverting to voicemail: a call
// that rings out returns an honest `no-answer`, whereas one that reaches voicemail returns
// `completed` and is indistinguishable from a human answering (see getCallOutcome).
const RING_TIMEOUT_SEC = 20;

/** Returns the Twilio call SID, which getCallOutcome needs on a later tick to decide on a retry. */
export async function placeCall(to: string, spokenMessage: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  // Inline TwiML rather than a hosted callback URL: the call is one-way, so there's nothing for
  // Twilio to POST back to and no public webhook to authenticate. loop=2 repeats the message
  // once, since a single pass is easy to miss on pickup.
  //
  // No leading <Pause>: answering-machine detection already withholds the TwiML until it has
  // classified the callee, so the first word can't be clipped by the connect, and a pause on top
  // of that delay is just silence the user waits through.
  const twiml =
    `<Response>` +
    `<Say voice="Polly.Matthew" loop="2">${escapeXml(spokenMessage)}</Say>` +
    `</Response>`;

  const res = await fetch(`${TWILIO_API}/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader(),
    },
    body: new URLSearchParams({
      To: to,
      From: process.env.TWILIO_FROM_NUMBER!,
      Twiml: twiml,
      Timeout: String(RING_TIMEOUT_SEC),
      // Without this, the retry loop cannot work at all: Twilio reports a call answered by
      // voicemail as `completed`, exactly like one answered by a person, so declining a call in
      // a meeting would look like a pickup and stop the ladder. AnsweredBy is the only field
      // that separates the two.
      MachineDetection: "Enable",
    }),
  });
  if (!res.ok) {
    throw new Error(`Twilio call failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { sid: string }).sid;
}

// What a placed call turned out to be, from the perspective of "do we call again?".
//   reached  - a person picked up; the ladder has done its job
//   missed   - rang out, was declined, hit voicemail, or failed; worth another attempt
//   pending  - still queued/ringing/talking; ask again on the next tick
export type CallOutcome = "reached" | "missed" | "pending";

export async function getCallOutcome(callSid: string): Promise<CallOutcome> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const res = await fetch(`${TWILIO_API}/${sid}/Calls/${callSid}.json`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(`Twilio call lookup failed: ${res.status} ${await res.text()}`);
  }
  const call = (await res.json()) as { status: string; answered_by?: string | null };

  if (["queued", "initiated", "ringing", "in-progress"].includes(call.status)) return "pending";
  // busy / no-answer / failed / canceled never connected to anything.
  if (call.status !== "completed") return "missed";

  // `completed` only means something answered. `unknown` is counted as a person on purpose:
  // detection failing is not evidence of a machine, and ringing someone three times because
  // Twilio couldn't classify them is the worse error.
  return call.answered_by === "human" || call.answered_by === "unknown" || !call.answered_by
    ? "reached"
    : "missed";
}
