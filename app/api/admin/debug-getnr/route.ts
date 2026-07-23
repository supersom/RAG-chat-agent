import { NextResponse } from "next/server";
import { getUserByEmailAnyTenant } from "@/app/lib/db/users";

export async function GET() {
  try {
    const result = await getUserByEmailAnyTenant("debug-probe3@example.com");
    return NextResponse.json({ calledOk: true, result });
  } catch (err: any) {
    return NextResponse.json({ calledOk: false, errMessage: err?.message });
  }
}
