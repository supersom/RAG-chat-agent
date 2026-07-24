"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MaskedInput } from "@/components/ui/masked-input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import type { RedactedTenant } from "@/app/lib/tenant-redact";

function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface TenantSettingsFormProps {
  tenant: RedactedTenant;
}

export default function TenantSettingsForm({
  tenant,
}: TenantSettingsFormProps) {
  const [knowledgeBaseId, setKnowledgeBaseId] = useState(
    tenant.knowledgeBaseId,
  );
  const [requireEndUserAuth, setRequireEndUserAuth] = useState(
    tenant.requireEndUserAuth,
  );
  const [guardrailId, setGuardrailId] = useState(tenant.guardrailId);
  const [guardrailVersion, setGuardrailVersion] = useState(
    tenant.guardrailVersion,
  );
  const [allowedOrigins, setAllowedOrigins] = useState(
    (tenant.allowedOrigins ?? []).join("\n"),
  );
  const [provider, setProvider] = useState(
    tenant.llmProviderDefaults.provider ?? "openai",
  );
  const [model, setModel] = useState(tenant.llmProviderDefaults.model ?? "");
  const [allowedModels, setAllowedModels] = useState(
    (tenant.llmProviderDefaults.allowedModels ?? []).join(", "),
  );
  const [apiKey, setApiKey] = useState("");
  const apiKeyConfigured = tenant.llmProviderDefaults.apiKeyConfigured;
  const [clearApiKey, setClearApiKey] = useState(false);
  const [amplifyAppId, setAmplifyAppId] = useState(tenant.amplifyAppId ?? "");
  const [awsRegion, setAwsRegion] = useState(tenant.awsRegion ?? "");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setIsSubmitting(true);

    const res = await fetch("/api/admin/tenant", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        knowledgeBaseId,
        requireEndUserAuth,
        guardrailId,
        guardrailVersion,
        allowedOrigins: parseList(allowedOrigins),
        amplifyAppId,
        awsRegion,
        llmProviderDefaults: {
          provider,
          model,
          allowedModels: parseList(allowedModels),
          apiKey: clearApiKey ? null : apiKey || undefined,
        },
      }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      setError("Failed to save tenant settings.");
      return;
    }

    setSaved(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tenant Settings</CardTitle>
        <CardDescription>
          Configure the knowledge base, guardrails, and access controls for
          your organization&apos;s assistant.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="knowledgeBaseId" className="text-sm font-medium">
              Knowledge Base ID
            </label>
            <Input
              id="knowledgeBaseId"
              value={knowledgeBaseId}
              onChange={(e) => setKnowledgeBaseId(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={requireEndUserAuth}
              onChange={(e) => setRequireEndUserAuth(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm font-medium">
              Require end-user authentication
            </span>
          </label>

          <div className="flex flex-col gap-1">
            <label htmlFor="guardrailId" className="text-sm font-medium">
              Guardrail ID
            </label>
            <Input
              id="guardrailId"
              value={guardrailId}
              onChange={(e) => setGuardrailId(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="guardrailVersion" className="text-sm font-medium">
              Guardrail Version
            </label>
            <Input
              id="guardrailVersion"
              value={guardrailVersion}
              onChange={(e) => setGuardrailVersion(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="allowedOrigins" className="text-sm font-medium">
              Allowed Origins
            </label>
            <Textarea
              id="allowedOrigins"
              placeholder={"https://example.com\nhttps://app.example.com"}
              value={allowedOrigins}
              onChange={(e) => setAllowedOrigins(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              One origin per line, or comma-separated.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="amplifyAppId" className="text-sm font-medium">
              Amplify App ID
            </label>
            <Input
              id="amplifyAppId"
              placeholder="abc123def"
              value={amplifyAppId}
              onChange={(e) => setAmplifyAppId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Used to fetch CloudWatch logs for this organization&apos;s
              deployment.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="awsRegion" className="text-sm font-medium">
              AWS Region
            </label>
            <Input
              id="awsRegion"
              placeholder="us-east-1"
              value={awsRegion}
              onChange={(e) => setAwsRegion(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as "openai" | "anthropic" | "openrouter")
              }
              className="border rounded-md px-3 py-2 text-sm bg-background"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="apiKey" className="text-sm font-medium">
              API Key
            </label>
            <MaskedInput
              id="apiKey"
              placeholder={
                apiKeyConfigured && !clearApiKey
                  ? "Configured (leave blank to keep)"
                  : "sk-..."
              }
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setClearApiKey(false);
              }}
              revealLabel="Show API key"
              hideLabel="Hide API key"
            />
            {apiKeyConfigured && (
              <label className="flex items-center gap-2 cursor-pointer w-fit text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(e) => {
                    setClearApiKey(e.target.checked);
                    if (e.target.checked) setApiKey("");
                  }}
                  className="h-3 w-3 accent-primary"
                />
                Clear the configured key (fall back to the main app&apos;s
                default provider)
              </label>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="model" className="text-sm font-medium">
              Model
            </label>
            <Input
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="allowedModels" className="text-sm font-medium">
              Allowed Models
            </label>
            <Input
              id="allowedModels"
              placeholder="claude-opus-4-6, claude-sonnet-5"
              value={allowedModels}
              onChange={(e) => setAllowedModels(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of model IDs.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && (
            <p className="text-sm text-muted-foreground">Settings saved.</p>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Settings"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
