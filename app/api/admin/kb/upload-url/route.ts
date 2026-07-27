import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { auth } from "@/auth";
import { getTenant, isKnowledgeBaseSharedWithOtherTenants } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";

const requestSchema = z.object({
  filename: z.string().min(1).max(255),
  dedupeKey: z.string().min(1).max(1024).optional(),
});

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

function addHashSuffix(filename: string, dedupeKey?: string): string {
  if (!dedupeKey) return filename;

  const hash = crypto
    .createHash("sha256")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 6);
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return `${filename}-${hash}`;

  return `${filename.slice(0, lastDot)}-${hash}${filename.slice(lastDot)}`;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const dataSource = await getKbDataSource(tenant.knowledgeBaseId);
  if (!dataSource) {
    return Response.json(
      { error: "Could not resolve this tenant's knowledge base data source" },
      { status: 400 },
    );
  }

  const key = addHashSuffix(
    sanitizeFilename(parsed.data.filename),
    parsed.data.dedupeKey,
  );

  const client = new S3Client({
    region: process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
  });

  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: dataSource.bucketName, Key: key }),
    { expiresIn: 300 },
  );

  const isShared = await isKnowledgeBaseSharedWithOtherTenants(
    tenant.knowledgeBaseId,
    tenant.tenantId,
  );

  return NextResponse.json({ uploadUrl, key, isShared });
}
