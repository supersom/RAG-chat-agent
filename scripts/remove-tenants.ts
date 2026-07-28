#!/usr/bin/env -S npx tsx
// One-off removal: delete a tenant's DynamoDB rows (Tenant, Users, Activity)
// for tenants being decommissioned rather than migrated into the pool. See
// DEVLOG.md "Pooled KB rollout" -- SDD Live Smoke Test, Embed Debug Org, and
// Org 2 were left on the legacy KBs as dev/QA artifacts, not real customers.
//
// DB rows only: does not touch S3 KB source content or keyword-index
// .sqlite files on the legacy buckets. Those buckets are shared and
// unnamespaced (pre-pool layout) -- KB1 also holds the already-migrated
// OpenAI Default Test Org's data, so a bulk delete by prefix isn't safe
// there and is deliberately out of scope for this script.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/remove-tenants.ts \
//     --tenant-id <tenantId> [--tenant-id <tenantId> ...] \
//     [--backup <path>] [--dry-run]
//
// Tenant IDs may also come from the TENANT_IDS (comma-separated) env var.
// Explicit input only, matching migrate-tenants-to-pool.ts -- no scanning
// the Tenants table by any heuristic. The human operator names exactly who
// is removed.
//
// --backup <path> writes every row about to be deleted (tenant + users +
// activity, per tenant) to a JSON file before any DeleteCommand runs, so a
// live run is recoverable via PutCommand replay if it turns out to be wrong.
// Written on both dry-run and live invocations, for symmetry with what the
// dry-run preview already shows.
//
// --dry-run resolves each tenant plus its Users and Activity rows and
// prints counts. Makes no AWS writes: no DeleteCommand of any kind.

import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../app/lib/db/client";
import { getTenant } from "../app/lib/db/tenants";
import { getUsersByTenant } from "../app/lib/db/users";
import { getActivityForTenant } from "../app/lib/db/activity";
import type { Tenant, User, ActivityRecord } from "../app/lib/db/schema";

const TENANTS_TABLE = process.env.DYNAMODB_TENANTS_TABLE!;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE!;
const ACTIVITY_TABLE =
  process.env.DYNAMODB_ACTIVITY_TABLE || "CustomerSupportAgent-Activity";

export interface RemovalConfig {
  tenantIds: string[];
  dryRun: boolean;
  backupPath?: string;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): RemovalConfig {
  const tenantIds: string[] = [];
  let dryRun = false;
  let backupPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--tenant-id":
      case "--tenant-ids": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        tenantIds.push(
          ...value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      }
      case "--backup": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        backupPath = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  if (tenantIds.length === 0 && env.TENANT_IDS) {
    tenantIds.push(
      ...env.TENANT_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const uniqueTenantIds = Array.from(new Set(tenantIds));

  if (uniqueTenantIds.length === 0) {
    throw new Error(
      "At least one tenant ID is required: pass --tenant-id <id> (repeatable, or comma-separated) or set TENANT_IDS.",
    );
  }

  return { tenantIds: uniqueTenantIds, dryRun, backupPath };
}

interface RemovalPlan {
  tenant: Tenant;
  users: User[];
  activity: ActivityRecord[];
}

// getActivityForTenant clamps to 100 rows/page for the app's own read paths;
// paginate through it with its existing `before` cursor rather than issuing
// a raw QueryCommand, so this stays in sync with however that table's key
// shape evolves.
async function getAllActivityForTenant(tenantId: string): Promise<ActivityRecord[]> {
  const all: ActivityRecord[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await getActivityForTenant({ tenantId, limit: 100, before });
    if (page.length === 0) break;
    all.push(...page);
    before = page[page.length - 1].createdAtActivityId;
    if (page.length < 100) break;
  }
  return all;
}

async function buildRemovalPlan(tenantId: string): Promise<RemovalPlan> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  const users = await getUsersByTenant(tenantId);
  const activity = await getAllActivityForTenant(tenantId);
  return { tenant, users, activity };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));

  console.log(`Tenants: ${config.tenantIds.join(", ")}`);
  console.log(`Mode:    ${config.dryRun ? "DRY RUN (read-only)" : "LIVE"}`);
  console.log("");

  const plans = new Map<string, RemovalPlan>();
  for (const tenantId of config.tenantIds) {
    console.log(`--- ${tenantId} ---`);
    const plan = await buildRemovalPlan(tenantId);
    console.log(`  name:            ${plan.tenant.name}`);
    console.log(`  knowledgeBaseId: ${plan.tenant.knowledgeBaseId}`);
    console.log(`  users:           ${plan.users.length}`);
    for (const user of plan.users) {
      console.log(`    ${user.userId}  ${user.email}  (${user.role})`);
    }
    console.log(`  activity rows:   ${plan.activity.length}`);
    console.log("");
    plans.set(tenantId, plan);
  }

  if (config.backupPath) {
    const backup = Object.fromEntries(plans);
    writeFileSync(config.backupPath, JSON.stringify(backup, null, 2));
    console.log(`Backup written to ${config.backupPath}`);
    console.log("");
  }

  if (config.dryRun) {
    console.log("Dry run complete. No AWS writes were performed.");
    return;
  }

  for (const tenantId of config.tenantIds) {
    const plan = plans.get(tenantId)!;

    console.log(`Deleting ${plan.activity.length} activity row(s) for ${tenantId}...`);
    for (const record of plan.activity) {
      await ddbDocClient.send(
        new DeleteCommand({
          TableName: ACTIVITY_TABLE,
          Key: {
            tenantId: record.tenantId,
            createdAtActivityId: record.createdAtActivityId,
          },
        }),
      );
    }

    console.log(`Deleting ${plan.users.length} user(s) for ${tenantId}...`);
    for (const user of plan.users) {
      await ddbDocClient.send(
        new DeleteCommand({
          TableName: USERS_TABLE,
          Key: { userId: user.userId },
        }),
      );
    }

    // Deleted last: if the script is interrupted mid-run, the tenant row
    // survives as the anchor to find and finish the cleanup, rather than
    // leaving orphaned users/activity with no tenant record pointing at them.
    console.log(`Deleting tenant ${tenantId}...`);
    await ddbDocClient.send(
      new DeleteCommand({
        TableName: TENANTS_TABLE,
        Key: { tenantId },
      }),
    );
  }

  console.log("Removal complete.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
