"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

export default function AdminEmbedPage() {
  const [token, setToken] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setIsGenerating(true);
    setError(null);
    setCopied(false);

    const res = await fetch("/api/tenant/embed-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    setIsGenerating(false);

    if (!res.ok) {
      setError("Failed to generate token.");
      return;
    }

    const data = await res.json();
    setToken(data.token);
  }

  const snippet = token
    ? `<iframe src="https://<your-domain>/?t=${token}"></iframe>`
    : "";

  async function handleCopy() {
    if (!snippet) return;
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Embed Snippet</CardTitle>
          <CardDescription>
            Generate a tenant-scoped embed token, then copy the snippet into
            your site.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? "Generating..." : "Generate Token"}
          </Button>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {token && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Token</label>
                <pre className="rounded-md border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all">
                  {token}
                </pre>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Embed snippet</label>
                <pre className="rounded-md border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap break-all">
                  {snippet}
                </pre>
              </div>

              <Button variant="outline" onClick={handleCopy} className="w-fit">
                {copied ? "Copied!" : "Copy snippet"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
