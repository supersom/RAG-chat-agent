import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ddbDocClient } from "./client";
import { ActivityRecord } from "./schema";

const TABLE_NAME =
  process.env.DYNAMODB_ACTIVITY_TABLE || "CustomerSupportAgent-Activity";
const DEFAULT_RETENTION_DAYS = 30;
const TENANT_USER_INDEX = "tenantUserId-createdAt-index";

export type NewActivityRecord = Omit<
  ActivityRecord,
  "activityId" | "createdAt" | "createdAtActivityId" | "tenantUserId" | "expiresAt"
> & {
  activityId?: string;
  createdAt?: string;
  expiresAt?: number;
};

export interface ActivityQueryOptions {
  tenantId: string;
  limit?: number;
  before?: string;
}

export interface TenantUserActivityQueryOptions extends ActivityQueryOptions {
  userId: string;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(Math.floor(limit!), 100));
}

function defaultExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + DEFAULT_RETENTION_DAYS * 24 * 60 * 60;
}

function createdAtFromCursor(cursor: string): string {
  return cursor.split("#", 1)[0];
}

export function buildActivityRecord(input: NewActivityRecord): ActivityRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const activityId = input.activityId ?? ulid();

  return {
    ...input,
    activityId,
    createdAt,
    createdAtActivityId: `${createdAt}#${activityId}`,
    tenantUserId: `${input.tenantId}#${input.userId}`,
    expiresAt: input.expiresAt ?? defaultExpiresAt(),
  };
}

export async function putActivityRecord(
  input: NewActivityRecord,
): Promise<ActivityRecord> {
  const record = buildActivityRecord(input);

  await ddbDocClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }),
  );

  return record;
}

export async function putChatTurnActivity(
  input: NewActivityRecord & { kind: "chat_turn" },
): Promise<ActivityRecord> {
  return putActivityRecord(input);
}

export async function putAppLogActivity(
  input: NewActivityRecord & { kind: "app_log" },
): Promise<ActivityRecord> {
  return putActivityRecord(input);
}

export async function getActivityForTenant({
  tenantId,
  limit,
  before,
}: ActivityQueryOptions): Promise<ActivityRecord[]> {
  const values: Record<string, string> = { ":tenantId": tenantId };
  let keyCondition = "tenantId = :tenantId";

  if (before) {
    keyCondition += " AND createdAtActivityId < :before";
    values[":before"] = before;
  }

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: clampLimit(limit),
    }),
  );

  return (result.Items as ActivityRecord[]) || [];
}

export async function getActivityForTenantUser({
  tenantId,
  userId,
  limit,
  before,
}: TenantUserActivityQueryOptions): Promise<ActivityRecord[]> {
  const values: Record<string, string> = {
    ":tenantUserId": `${tenantId}#${userId}`,
  };
  let keyCondition = "tenantUserId = :tenantUserId";

  if (before) {
    keyCondition += " AND createdAt < :beforeCreatedAt";
    values[":beforeCreatedAt"] = createdAtFromCursor(before);
  }

  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: TENANT_USER_INDEX,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: clampLimit(limit),
    }),
  );

  return (result.Items as ActivityRecord[]) || [];
}

export const getActivityForUser = getActivityForTenantUser;
