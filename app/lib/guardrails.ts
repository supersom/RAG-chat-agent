import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";

export interface GuardrailResult {
  blocked: boolean;
  outputText: string;
}

export async function applyGuardrail(params: {
  text: string;
  source: "INPUT" | "OUTPUT";
  guardrailId: string;
  guardrailVersion: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region?: string;
}): Promise<GuardrailResult> {
  // No guardrail configured for this tenant yet (e.g. a freshly signed-up
  // tenant) — skip screening entirely rather than letting AWS reject an
  // empty guardrail identifier and falling into the caller's error handling.
  if (!params.guardrailId) {
    return { blocked: false, outputText: params.text };
  }

  const client = new BedrockRuntimeClient({
    region: params.region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: params.credentials,
  });

  const response = await client.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: params.guardrailId,
      guardrailVersion: params.guardrailVersion,
      source: params.source,
      content: [{ text: { text: params.text } }],
    }),
  );

  if (response.action === "GUARDRAIL_INTERVENED") {
    return {
      blocked: true,
      outputText:
        response.outputs
          ?.map((o) => o.text)
          .filter(Boolean)
          .join(" ") || "This message can't be processed.",
    };
  }

  return { blocked: false, outputText: params.text };
}
