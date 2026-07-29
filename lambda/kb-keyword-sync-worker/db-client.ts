import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Unlike app/lib/db/client.ts, this never sets explicit credentials - this
// Lambda has its own IAM execution role (see infra/terraform/kb_keyword_sync.tf),
// and the AWS SDK's default credential provider chain discovers it
// automatically from the Lambda runtime environment. No BAWS_* env vars
// exist in this Lambda's environment at all.
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-2",
});

export const workerDbClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
