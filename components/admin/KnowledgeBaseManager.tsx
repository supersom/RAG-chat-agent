"use client";

import { useEffect, useRef, useState } from "react";
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

type UploadableFile = File & { webkitRelativePath?: string };

export default function KnowledgeBaseManager() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedKeys, setUploadedKeys] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isShared, setIsShared] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [ingestion, setIngestion] = useState<IngestionStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);


  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  function selectedFiles(): UploadableFile[] {
    return [
      ...Array.from(fileInputRef.current?.files ?? []),
      ...Array.from(folderInputRef.current?.files ?? []),
    ] as UploadableFile[];
  }

  function clearSelectedFiles() {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }

  function flattenedUploadName(file: UploadableFile): string {
    const base = file.name.split(/[/\\]/).pop() || "file";
    return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  }

  function uploadIdentity(file: UploadableFile, index: number): string {
    const sourcePath = file.webkitRelativePath || file.name;
    return `${sourcePath}:${file.size}:${file.lastModified}:${index}`;
  }

  async function handleUpload() {
    const files = selectedFiles();
    if (files.length === 0) return;

    setUploadError(null);
    setUploadedKeys([]);
    setUploadProgress(null);
    setIsUploading(true);

    const uploaded: string[] = [];

    try {
      const nameCounts = files.reduce<Record<string, number>>((counts, file) => {
        const name = flattenedUploadName(file);
        counts[name] = (counts[name] || 0) + 1;
        return counts;
      }, {});

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const sourcePath = file.webkitRelativePath || file.name;
        const flattenedName = flattenedUploadName(file);
        const dedupeKey =
          nameCounts[flattenedName] > 1 ? uploadIdentity(file, index) : undefined;
        setUploadProgress(`Uploading ${index + 1} of ${files.length}: ${sourcePath}`);

        const res = await fetch("/api/admin/kb/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, dedupeKey }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(
            typeof data?.error === "string"
              ? data.error
              : `Failed to get upload URL for ${sourcePath}.`,
          );
        }

        const { uploadUrl, key, isShared: shared } = await res.json();

        const putRes = await fetch(uploadUrl, { method: "PUT", body: file });
        if (!putRes.ok) {
          throw new Error(`Upload to S3 failed for ${sourcePath}.`);
        }

        uploaded.push(key);
        setUploadedKeys([...uploaded]);
        setIsShared(shared);
      }

      clearSelectedFiles();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadProgress(null);
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
          <CardTitle>Upload documents</CardTitle>
          <CardDescription>
            Add one or more files, or a local folder, to your organization&apos;s
            knowledge base.
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
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Files</span>
              <input ref={fileInputRef} type="file" multiple disabled={isUploading} className="text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Folder</span>
              <input ref={folderInputRef} type="file" multiple disabled={isUploading} className="text-sm" />
            </label>
          </div>
          {uploadError && (
            <p className="text-sm text-destructive">{uploadError}</p>
          )}
          {uploadProgress && (
            <p className="text-sm text-muted-foreground">{uploadProgress}</p>
          )}
          {uploadedKeys.length > 0 && !uploadError && (
            <div className="text-sm text-muted-foreground">
              <p>
                Uploaded {uploadedKeys.length} item
                {uploadedKeys.length === 1 ? "" : "s"}. Run a sync below to
                make them searchable.
              </p>
              <ul className="mt-2 max-h-32 list-disc overflow-y-auto pl-5 font-mono text-xs">
                {uploadedKeys.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
            </div>
          )}
          <Button onClick={handleUpload} disabled={isUploading} className="w-fit">
            {isUploading ? "Uploading..." : "Upload selected"}
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
