import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource, getKnowledgeBaseDocumentsStatus } from "@/app/lib/bedrock-kb";

const statusRequestSchema = z.object({
  keys: z.array(z.string()).min(1),
});

// Fire-and-poll: POST /api/admin/kb/sync submits documents for
// ingestion/deletion and returns immediately with their initial (usually
// STARTING) status; the client polls here with that same key list to watch
// them reach a terminal status (INDEXED/FAILED/NOT_FOUND/etc).
//
// This is a POST, not a GET-with-query-param, because a large tenant's key
// list doesn't fit in a URL: a full sync's ~2,000 keys join to over 200,000
// characters, well past any reasonable URL length limit.
export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const bodyText = await req.text();
  const parsed = statusRequestSchema.safeParse(
    (() => {
      try {
        return bodyText ? JSON.parse(bodyText) : null;
      } catch {
        return null;
      }
    })(),
  );
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

  const documents = await getKnowledgeBaseDocumentsStatus({
    knowledgeBaseId: tenant.knowledgeBaseId,
    dataSourceId: dataSource.dataSourceId,
    bucketName: dataSource.bucketName,
    keys: parsed.data.keys,
  });

  return NextResponse.json({ documents });
}
