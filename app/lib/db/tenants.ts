import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./client";
import { Tenant } from "./schema";

const TABLE_NAME = process.env.DYNAMODB_TENANTS_TABLE!;

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { tenantId },
    }),
  );

  return (result.Item as Tenant) || null;
}

export async function createTenant(
  input: Omit<Tenant, "createdAt">,
): Promise<Tenant> {
  const tenant: Tenant = {
    ...input,
    createdAt: new Date().toISOString(),
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: tenant,
    }),
  );

  return tenant;
}

export async function updateTenant(
  tenantId: string,
  patch: Partial<Omit<Tenant, "tenantId" | "createdAt">>,
): Promise<Tenant> {
  const existing = await getTenant(tenantId);
  if (!existing) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const updated: Tenant = { ...existing, ...patch };

  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: updated,
    }),
  );

  return updated;
}
