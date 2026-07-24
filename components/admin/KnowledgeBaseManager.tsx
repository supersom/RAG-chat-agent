"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

type IngestionStatus = {
  status?: string;
  statistics?: {
    numberOfDocumentsScanned?: number;
    numberOfNewDocumentsIndexed?: number;
    numberOfModifiedDocumentsIndexed?: number;
    numberOfDocumentsFailed?: number;
  };
};

const TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED"]);
const POLL_INTERVAL_MS = 5000;

export default function KnowledgeBaseManager() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [isShared, setIsShared] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [ingestion, setIngestion] = useState<IngestionStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function handleUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setUploadError(null);
    setUploadedKey(null);
    setIsUploading(true);

    try {
      const res = await fetch("/api/admin/kb/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to get upload URL.",
        );
      }

      const { uploadUrl, key, isShared: shared } = await res.json();

      const putRes = await fetch(uploadUrl, { method: "PUT", body: file });
      if (!putRes.ok) {
        throw new Error("Upload to S3 failed.");
      }

      setUploadedKey(key);
      setIsShared(shared);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function pollIngestion(id: string) {
    const res = await fetch(`/api/admin/kb/sync?jobId=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data: IngestionStatus = await res.json();
    setIngestion(data);

    if (data.status && !TERMINAL_STATUSES.has(data.status)) {
      setTimeout(() => pollIngestion(id), POLL_INTERVAL_MS);
    } else {
      setIsSyncing(false);
    }
  }

  async function handleSync() {
    setSyncError(null);
    setIngestion(null);
    setIsSyncing(true);

    const res = await fetch("/api/admin/kb/sync", { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setSyncError(
        typeof data?.error === "string" ? data.error : "Failed to start sync.",
      );
      setIsSyncing(false);
      return;
    }

    const { jobId: newJobId } = await res.json();
    setJobId(newJobId);
    pollIngestion(newJobId);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload a document</CardTitle>
          <CardDescription>
            Add a new document to your organization&apos;s knowledge base.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isShared && (
            <p className="rounded-md border border-yellow-600/40 bg-yellow-600/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              Note: this knowledge base is shared with at least one other
              organization. Documents you add here will be visible to their
              chat as well.
            </p>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="text-sm"
          />
          {uploadError && (
            <p className="text-sm text-destructive">{uploadError}</p>
          )}
          {uploadedKey && !uploadError && (
            <p className="text-sm text-muted-foreground">
              Uploaded <span className="font-mono">{uploadedKey}</span>. Run a
              sync below to make it searchable.
            </p>
          )}
          <Button onClick={handleUpload} disabled={isUploading} className="w-fit">
            {isUploading ? "Uploading..." : "Upload"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sync knowledge base</CardTitle>
          <CardDescription>
            Newly uploaded documents aren&apos;t searchable until a sync
            completes. This rescans the entire knowledge base, so it can take
            a while if it holds a large number of existing documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button onClick={handleSync} disabled={isSyncing} className="w-fit">
            {isSyncing ? "Syncing..." : "Sync Knowledge Base"}
          </Button>
          {syncError && <p className="text-sm text-destructive">{syncError}</p>}
          {jobId && ingestion && (
            <div className="text-sm text-muted-foreground">
              <p>
                Status: <span className="font-medium">{ingestion.status}</span>
              </p>
              {ingestion.statistics && (
                <p>
                  Scanned {ingestion.statistics.numberOfDocumentsScanned ?? 0},
                  indexed {ingestion.statistics.numberOfNewDocumentsIndexed ?? 0}
                  {(ingestion.statistics.numberOfModifiedDocumentsIndexed ?? 0) >
                    0 &&
                    `, modified ${ingestion.statistics.numberOfModifiedDocumentsIndexed}`}
                  {(ingestion.statistics.numberOfDocumentsFailed ?? 0) > 0 &&
                    `, ${ingestion.statistics.numberOfDocumentsFailed} failed`}
                  .
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
