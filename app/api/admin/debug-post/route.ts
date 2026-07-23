import { NextResponse } from "next/server";
import { getUserByEmailAnyTenant } from "@/app/lib/db/users";

export async function POST(req: Request) {
  await req.json().catch(() => ({}));
  try {
    const result = await getUserByEmailAnyTenant("debug-probe2@example.com");
    return NextResponse.json({ calledOk: true, result });
  } catch (err: any) {
    return NextResponse.json({ calledOk: false, errMessage: err?.message });
  }
}
