import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant, updateTenant } from "@/app/lib/db/tenants";

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
        provider: z.string(),
        model: z.string(),
        allowedModels: z.array(z.string()).optional(),
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

  return NextResponse.json(tenant);
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

  const updated = await updateTenant(session.user.tenantId, parsed.data);

  return NextResponse.json(updated);
}
