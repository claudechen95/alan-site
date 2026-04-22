import { NextResponse } from "next/server";
import { getRemindHour, setRemindHour } from "@/lib/kv";

export async function GET() {
  const remindHour = await getRemindHour();
  return NextResponse.json({ remindHour });
}

export async function POST(req: Request) {
  const { remindHour } = await req.json();
  if (typeof remindHour !== "number" || remindHour < 0 || remindHour > 23) {
    return NextResponse.json({ error: "Invalid hour" }, { status: 400 });
  }
  await setRemindHour(remindHour);
  return NextResponse.json({ ok: true, remindHour });
}
