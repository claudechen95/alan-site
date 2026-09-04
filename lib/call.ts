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

export async function placeCall(to: string, spokenMessage: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  // Inline TwiML rather than a hosted callback URL: the call is one-way, so there's nothing for
  // Twilio to POST back to and no public webhook to authenticate.
  // The leading pause keeps the first word from being clipped by the connect, and loop=2 repeats
  // the message once, since a single pass is easy to miss on pickup.
  const twiml =
    `<Response><Pause length="1"/>` +
    `<Say voice="Polly.Matthew" loop="2">${escapeXml(spokenMessage)}</Say>` +
    `</Response>`;

  const res = await fetch(`${TWILIO_API}/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      To: to,
      From: process.env.TWILIO_FROM_NUMBER!,
      Twiml: twiml,
    }),
  });
  if (!res.ok) {
    throw new Error(`Twilio call failed: ${res.status} ${await res.text()}`);
  }
}
