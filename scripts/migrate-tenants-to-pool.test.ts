import { describe, it, expect } from "vitest";
import {
  parseArgs,
  isMigratableObject,
  destinationKey,
  buildCopyPlan,
} from "./migrate-tenants-to-pool";

describe("parseArgs", () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it("parses required flags", () => {
    const config = parseArgs(
      ["--tenant-id", "t1", "--pool-kb-id", "PKB", "--pool-bucket", "pool-bucket"],
      baseEnv,
    );
    expect(config).toEqual({
      tenantIds: ["t1"],
      poolKbId: "PKB",
      poolBucket: "pool-bucket",
      dryRun: false,
    });
  });

  it("accepts repeated --tenant-id flags and dedupes", () => {
    const config = parseArgs(
      [
        "--tenant-id",
        "t1",
        "--tenant-id",
        "t2",
        "--tenant-id",
        "t1",
        "--pool-kb-id",
        "PKB",
        "--pool-bucket",
        "pool-bucket",
      ],
      baseEnv,
    );
    expect(config.tenantIds).toEqual(["t1", "t2"]);
  });

  it("accepts a comma-separated --tenant-id value", () => {
    const config = parseArgs(
      ["--tenant-id", "t1,t2, t3", "--pool-kb-id", "PKB", "--pool-bucket", "pool-bucket"],
      baseEnv,
    );
    expect(config.tenantIds).toEqual(["t1", "t2", "t3"]);
  });

  it("sets dryRun when --dry-run is passed", () => {
    const config = parseArgs(
      ["--tenant-id", "t1", "--pool-kb-id", "PKB", "--pool-bucket", "pool-bucket", "--dry-run"],
      baseEnv,
    );
    expect(config.dryRun).toBe(true);
  });

  it("falls back to env vars for tenant IDs, pool KB ID, and pool bucket", () => {
    const env = {
      TENANT_IDS: "t1,t2",
      POOL_KB_ID: "PKB",
      POOL_BUCKET_NAME: "pool-bucket",
    } as unknown as NodeJS.ProcessEnv;
    const config = parseArgs([], env);
    expect(config).toEqual({
      tenantIds: ["t1", "t2"],
      poolKbId: "PKB",
      poolBucket: "pool-bucket",
      dryRun: false,
    });
  });

  it("prefers CLI tenant IDs over TENANT_IDS env var", () => {
    const env = { TENANT_IDS: "envtenant" } as unknown as NodeJS.ProcessEnv;
    const config = parseArgs(
      ["--tenant-id", "clitenant", "--pool-kb-id", "PKB", "--pool-bucket", "pool-bucket"],
      env,
    );
    expect(config.tenantIds).toEqual(["clitenant"]);
  });

  it("throws when no tenant ID is provided", () => {
    expect(() => parseArgs(["--pool-kb-id", "PKB", "--pool-bucket", "pool-bucket"], baseEnv)).toThrow(
      /tenant ID/,
    );
  });

  it("throws when pool KB ID is missing", () => {
    expect(() => parseArgs(["--tenant-id", "t1", "--pool-bucket", "pool-bucket"], baseEnv)).toThrow(
      /Pool KB ID/,
    );
  });

  it("throws when pool bucket is missing", () => {
    expect(() => parseArgs(["--tenant-id", "t1", "--pool-kb-id", "PKB"], baseEnv)).toThrow(
      /Pool bucket/,
    );
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseArgs(["--nonsense"], baseEnv)).toThrow(/Unrecognized argument/);
  });
});

describe("isMigratableObject", () => {
  it("accepts ordinary content keys", () => {
    expect(isMigratableObject("policy.pdf")).toBe(true);
    expect(isMigratableObject("pdfs/some doc (v2).pdf")).toBe(true);
  });

  it("rejects directory markers", () => {
    expect(isMigratableObject("pdfs/")).toBe(false);
  });

  it("rejects the internal keyword-index prefix", () => {
    expect(
      isMigratableObject(".customer-support-agent/keyword-indexes/t1/KBID.sqlite"),
    ).toBe(false);
  });

  it("rejects existing metadata sidecars", () => {
    expect(isMigratableObject("policy.pdf.metadata.json")).toBe(false);
  });
});

describe("destinationKey", () => {
  it("namespaces under tenants/{tenantId}/", () => {
    expect(destinationKey("t1", "policy.pdf")).toBe("tenants/t1/policy.pdf");
    expect(destinationKey("t1", "pdfs/nested/file.pdf")).toBe(
      "tenants/t1/pdfs/nested/file.pdf",
    );
  });
});

describe("buildCopyPlan", () => {
  it("filters excluded keys and computes dest + sidecar keys", () => {
    const plan = buildCopyPlan("t1", [
      "policy.pdf",
      "pdfs/",
      ".customer-support-agent/keyword-indexes/t1/KBID.sqlite",
      "policy.pdf.metadata.json",
      "notes.md",
    ]);

    expect(plan).toEqual([
      {
        sourceKey: "policy.pdf",
        destKey: "tenants/t1/policy.pdf",
        sidecarKey: "tenants/t1/policy.pdf.metadata.json",
      },
      {
        sourceKey: "notes.md",
        destKey: "tenants/t1/notes.md",
        sidecarKey: "tenants/t1/notes.md.metadata.json",
      },
    ]);
  });

  it("returns an empty plan for an empty bucket listing", () => {
    expect(buildCopyPlan("t1", [])).toEqual([]);
  });
});
