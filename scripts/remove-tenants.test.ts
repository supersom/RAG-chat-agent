import { describe, it, expect } from "vitest";
import { parseArgs } from "./remove-tenants";

describe("parseArgs", () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it("parses a single --tenant-id", () => {
    const config = parseArgs(["--tenant-id", "t1"], baseEnv);
    expect(config).toEqual({ tenantIds: ["t1"], dryRun: false, backupPath: undefined });
  });

  it("parses --backup", () => {
    const config = parseArgs(["--tenant-id", "t1", "--backup", "/tmp/out.json"], baseEnv);
    expect(config.backupPath).toBe("/tmp/out.json");
  });

  it("accepts repeated --tenant-id flags and dedupes", () => {
    const config = parseArgs(
      ["--tenant-id", "t1", "--tenant-id", "t2", "--tenant-id", "t1"],
      baseEnv,
    );
    expect(config.tenantIds).toEqual(["t1", "t2"]);
  });

  it("accepts a comma-separated --tenant-id value", () => {
    const config = parseArgs(["--tenant-id", "t1,t2, t3"], baseEnv);
    expect(config.tenantIds).toEqual(["t1", "t2", "t3"]);
  });

  it("sets dryRun when --dry-run is passed", () => {
    const config = parseArgs(["--tenant-id", "t1", "--dry-run"], baseEnv);
    expect(config.dryRun).toBe(true);
  });

  it("falls back to the TENANT_IDS env var", () => {
    const env = { TENANT_IDS: "t1,t2" } as unknown as NodeJS.ProcessEnv;
    const config = parseArgs([], env);
    expect(config).toEqual({ tenantIds: ["t1", "t2"], dryRun: false });
  });

  it("prefers CLI tenant IDs over TENANT_IDS env var", () => {
    const env = { TENANT_IDS: "envtenant" } as unknown as NodeJS.ProcessEnv;
    const config = parseArgs(["--tenant-id", "clitenant"], env);
    expect(config.tenantIds).toEqual(["clitenant"]);
  });

  it("throws when no tenant ID is provided", () => {
    expect(() => parseArgs([], baseEnv)).toThrow(/tenant ID/);
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseArgs(["--nonsense"], baseEnv)).toThrow(/Unrecognized argument/);
  });
});
