import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { encryptApiKey, decryptApiKey } from "./tenant-secrets";

function stubKey() {
  const key = crypto.randomBytes(32).toString("base64");
  process.env.TENANT_SECRETS_KEY = key;
  return key;
}

beforeEach(() => {
  delete process.env.TENANT_SECRETS_KEY;
});

afterEach(() => {
  delete process.env.TENANT_SECRETS_KEY;
});

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips a plaintext key", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-ant-super-secret-value");
    expect(ciphertext).not.toContain("sk-ant-super-secret-value");
    expect(decryptApiKey(ciphertext)).toBe("sk-ant-super-secret-value");
  });

  it("produces different ciphertext for the same plaintext on repeated calls", () => {
    stubKey();
    const a = encryptApiKey("same-value");
    const b = encryptApiKey("same-value");
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe("same-value");
    expect(decryptApiKey(b)).toBe("same-value");
  });

  it("throws when the ciphertext has been tampered with", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-real-value");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptApiKey(tampered)).toThrow();
  });

  it("throws when decrypting with a different key than it was encrypted with", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-real-value");
    stubKey();
    expect(() => decryptApiKey(ciphertext)).toThrow();
  });

  it("throws when TENANT_SECRETS_KEY is not configured", () => {
    expect(() => encryptApiKey("value")).toThrow("TENANT_SECRETS_KEY");
    expect(() => decryptApiKey("aGVsbG8=")).toThrow("TENANT_SECRETS_KEY");
  });

  it("throws when TENANT_SECRETS_KEY doesn't decode to 32 bytes", () => {
    process.env.TENANT_SECRETS_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptApiKey("value")).toThrow("32 bytes");
  });
});
