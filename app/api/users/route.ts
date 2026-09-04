import { NextResponse } from "next/server";
import { getUsers, addUser, removeUser, setUserPhone, setUserPartnerPhone } from "@/lib/kv";

export async function GET() {
  return NextResponse.json(await getUsers());
}

export async function POST(req: Request) {
  const { id, label, checkinTopic, phone } = await req.json();
  if (!id || !label) {
    return NextResponse.json({ error: "id and label required" }, { status: 400 });
  }
  await addUser(id, label, checkinTopic, phone);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const { id, phone, partnerPhone } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Each number is only touched when its key is present, so editing one can't blank the other.
  if (phone !== undefined) await setUserPhone(id, phone);
  if (partnerPhone !== undefined) await setUserPartnerPhone(id, partnerPhone);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeUser(id);
  return NextResponse.json({ ok: true });
}
