import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ddbDocClient } from "./client";
import { User } from "./schema";

const TABLE_NAME = process.env.DYNAMODB_USERS_TABLE!;

export async function getUserByEmail(
  tenantId: string,
  email: string,
): Promise<User | null> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email AND tenantId = :tenantId",
      ExpressionAttributeValues: {
        ":email": email,
        ":tenantId": tenantId,
      },
    }),
  );

  return (result.Items?.[0] as User) || null;
}

// Intentionally unscoped by tenant — used only for the admin-login path, where
// the tenant isn't known until after the user is authenticated.
export async function getUserByEmailAnyTenant(
  email: string,
): Promise<User | null> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email,
      },
    }),
  );

  return (result.Items?.[0] as User) || null;
}

export async function createUser(
  input: Omit<User, "userId" | "createdAt">,
): Promise<User> {
  const user: User = {
    ...input,
    userId: ulid(),
    createdAt: new Date().toISOString(),
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: user,
    }),
  );

  return user;
}
