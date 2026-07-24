import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";

export async function POST(req: Request) {
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

  const { startTime } = await req.json();

  const appId = tenant.amplifyAppId || process.env.AMPLIFY_APP_ID;
  const region = tenant.awsRegion || process.env.AWS_REGION || "us-east-2";
  const accessKeyId = process.env.BAWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BAWS_SECRET_ACCESS_KEY;

  if (!appId) {
    return Response.json({ error: "Amplify App ID not configured" }, { status: 400 });
  }

  const client = new CloudWatchLogsClient({
    region,
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  });

  const logGroupName = `/aws/amplify/${appId}`;
  const queryStartTime = startTime ?? Date.now() - 10 * 60 * 1000;

  try {
    const response = await client.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: queryStartTime,
        limit: 200,
      })
    );
    return Response.json({ events: response.events ?? [] });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
