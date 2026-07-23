import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export async function POST(req: Request) {
  const { amplifyAppId, awsRegion, bawsAccessKeyId, bawsSecretAccessKey, startTime } =
    await req.json();

  const appId = amplifyAppId || process.env.AMPLIFY_APP_ID;
  const region = awsRegion || process.env.AWS_REGION || "us-east-2";
  const accessKeyId = bawsAccessKeyId || process.env.BAWS_ACCESS_KEY_ID;
  const secretAccessKey = bawsSecretAccessKey || process.env.BAWS_SECRET_ACCESS_KEY;

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
