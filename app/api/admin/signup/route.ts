import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { createTenant } from "@/app/lib/db/tenants";
import { createUser } from "@/app/lib/db/users";
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
