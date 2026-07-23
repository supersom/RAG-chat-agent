import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { signTenantToken } from "@/app/lib/tenant";

const embedTokenSchema = z.object({
  allowedOrigins: z.array(z.string()).optional(),
  expiresIn: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = embedTokenSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { allowedOrigins, expiresIn } = parsed.data;

  const token = await signTenantToken(
    { tenantId: session.user.tenantId, allowedOrigins },
    { expiresIn },
  );

  return NextResponse.json({ token });
}
