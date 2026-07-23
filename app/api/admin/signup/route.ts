import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { createTenant } from "@/app/lib/db/tenants";
import { createUser, getUserByEmailAnyTenant } from "@/app/lib/db/users";
import { hashPassword } from "@/app/lib/auth/passwords";

const signupSchema = z.object({
  tenantName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = signupSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { tenantName, email, password } = parsed.data;

  let existingUser;
  try {
    existingUser = await getUserByEmailAnyTenant(email);
  } catch (err: any) {
    return NextResponse.json(
      {
        TEMP_DIAG: true,
        errName: err?.name,
        errMessage: err?.message,
        errConstructor: err?.constructor?.name,
        accessKeyIdLen: (process.env.BAWS_ACCESS_KEY_ID || "").length,
        secretKeyLen: (process.env.BAWS_SECRET_ACCESS_KEY || "").length,
        accessKeyIdType: typeof process.env.BAWS_ACCESS_KEY_ID,
        secretKeyType: typeof process.env.BAWS_SECRET_ACCESS_KEY,
      },
      { status: 500 },
    );
  }
  if (existingUser) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 },
    );
  }

  const tenant = await createTenant({
    tenantId: ulid(),
    name: tenantName,
    knowledgeBaseId: process.env.NEXT_PUBLIC_KNOWLEDGE_BASE_ID || "",
    llmProviderDefaults: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    },
    requireEndUserAuth: false,
    guardrailId: "",
    guardrailVersion: "",
  });

  try {
    await createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "admin",
      tenantId: tenant.tenantId,
    });
  } catch (err) {
    console.error(
      `Orphaned tenant created without an admin user: ${tenant.tenantId}`,
      err,
    );
    return NextResponse.json(
      { error: "Failed to create admin user." },
      { status: 500 },
    );
  }

  return NextResponse.json({ tenantId: tenant.tenantId });
}
