import { z } from "zod";
import { ulid } from "ulid";
import { createTenant } from "@/app/lib/db/tenants";
import { getUserByEmailAnyTenant } from "@/app/lib/db/users";
import { hashPassword } from "@/app/lib/auth/passwords";

void z; void ulid; void createTenant; void getUserByEmailAnyTenant; void hashPassword;

export async function GET() {
  return Response.json({
    accessKeyIdLen: (process.env.BAWS_ACCESS_KEY_ID || "").length,
    secretKeyLen: (process.env.BAWS_SECRET_ACCESS_KEY || "").length,
  });
}
