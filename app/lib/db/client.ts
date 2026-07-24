import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Constructed lazily (on first use) rather than at module top level: reading
// process.env at import time returned undefined credentials under Amplify's
// Web Compute build/bundling, silently baking a broken client into the
// deployed bundle. Every other AWS client in this codebase is built inside
// its call site for the same reason — this one should be no different.
let ddbDocClientInstance: DynamoDBDocumentClient | undefined;

function getDdbDocClient(): DynamoDBDocumentClient {
  if (!ddbDocClientInstance) {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
      },
    });
    ddbDocClientInstance = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return ddbDocClientInstance;
}

export const ddbDocClient = new Proxy({} as DynamoDBDocumentClient, {
  get(_target, prop) {
    const real = getDdbDocClient();
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
