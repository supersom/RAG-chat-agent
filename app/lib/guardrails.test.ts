import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  ApplyGuardrailCommand: vi.fn().mockImplementation(function (input) {
    return { input };
  }),
}));

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { applyGuardrail } from "./guardrails";

const mockedApplyGuardrailCommand = vi.mocked(ApplyGuardrailCommand);
const mockedBedrockRuntimeClient = vi.mocked(BedrockRuntimeClient);

const baseParams = {
  text: "some user input",
  source: "INPUT" as const,
  guardrailId: "gr-123",
  guardrailVersion: "1",
  credentials: { accessKeyId: "AKIA...", secretAccessKey: "secret" },
};

beforeEach(() => {
  sendMock.mockReset();
  mockedApplyGuardrailCommand.mockClear();
  mockedBedrockRuntimeClient.mockClear();
  vi.unstubAllEnvs();
  delete process.env.AWS_REGION;
});

describe("applyGuardrail", () => {
  it("returns blocked=true with the guardrail's message when GUARDRAIL_INTERVENED", async () => {
    sendMock.mockResolvedValue({
      action: "GUARDRAIL_INTERVENED",
      outputs: [{ text: "blocked message" }],
    });

    const result = await applyGuardrail(baseParams);

    expect(result).toEqual({ blocked: true, outputText: "blocked message" });
  });

  it("passes the input text through unchanged when action is NONE", async () => {
    sendMock.mockResolvedValue({ action: "NONE" });

    const result = await applyGuardrail(baseParams);

    expect(result).toEqual({ blocked: false, outputText: baseParams.text });
  });

  it("builds the ApplyGuardrailCommand and client from the given params", async () => {
    sendMock.mockResolvedValue({ action: "NONE" });

    await applyGuardrail(baseParams);

    expect(mockedBedrockRuntimeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        credentials: baseParams.credentials,
      }),
    );
    expect(mockedApplyGuardrailCommand).toHaveBeenCalledWith({
      guardrailIdentifier: baseParams.guardrailId,
      guardrailVersion: baseParams.guardrailVersion,
      source: baseParams.source,
      content: [{ text: { text: baseParams.text } }],
    });
  });

  it("skips the AWS call and passes text through unchanged when guardrailId is empty", async () => {
    const result = await applyGuardrail({ ...baseParams, guardrailId: "" });

    expect(result).toEqual({ blocked: false, outputText: baseParams.text });
    expect(mockedBedrockRuntimeClient).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
