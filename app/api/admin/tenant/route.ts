import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant, updateTenant } from "@/app/lib/db/tenants";
import { redactTenant } from "@/app/lib/tenant-redact";
import { mergeLlmProviderDefaults } from "@/app/lib/tenant-llm-patch";
import type { Tenant } from "@/app/lib/db/schema";

const editableTenantSchema = z
  .object({
    knowledgeBaseId: z.string().optional(),
    requireEndUserAuth: z.boolean().optional(),
    guardrailId: z.string().optional(),
    guardrailVersion: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    amplifyAppId: z.string().optional(),
    awsRegion: z.string().optional(),
    llmProviderDefaults: z
      .object({
        provider: z.enum(["openai", "anthropic", "openrouter"]).optional(),
        model: z.string().optional(),
        allowedModels: z.array(z.string()).optional(),
        apiKey: z.string().nullable().optional(),
      })
      .optional(),
  })
  .strict();

export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  return NextResponse.json(redactTenant(tenant));
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = editableTenantSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await getTenant(session.user.tenantId);
  if (!existing) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const { llmProviderDefaults: patchDefaults, ...rest } = parsed.data;

  let llmProviderDefaults: Tenant["llmProviderDefaults"] = existing.llmProviderDefaults;

  if (patchDefaults) {
    const result = mergeLlmProviderDefaults(existing.llmProviderDefaults, patchDefaults);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    llmProviderDefaults = result.llmProviderDefaults;
  }

  const updated = await updateTenant(session.user.tenantId, {
    ...rest,
    llmProviderDefaults,
  });

  return NextResponse.json(redactTenant(updated));
}
