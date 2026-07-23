import { z } from "zod";
import { ulid } from "ulid";
import { createTenant } from "@/app/lib/db/tenants";
import { getUserByEmailAnyTenant } from "@/app/lib/db/users";
import { hashPassword } from "@/app/lib/auth/passwords";

void z; void ulid; void createTenant; void hashPassword;

export async function GET() {
  try {
    const result = await getUserByEmailAnyTenant("debug-probe@example.com");
    return Response.json({
      calledOk: true,
      result,
      accessKeyIdLen: (process.env.BAWS_ACCESS_KEY_ID || "").length,
      secretKeyLen: (process.env.BAWS_SECRET_ACCESS_KEY || "").length,
    });
  } catch (err: any) {
    return Response.json({
      calledOk: false,
      errMessage: err?.message,
      accessKeyIdLen: (process.env.BAWS_ACCESS_KEY_ID || "").length,
      secretKeyLen: (process.env.BAWS_SECRET_ACCESS_KEY || "").length,
    });
  }
}
