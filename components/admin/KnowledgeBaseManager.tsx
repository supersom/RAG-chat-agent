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

type SyncMode = "full" | "incremental";

type DocumentSyncStatus = {
  key: string;
  status?: string;
  statusReason?: string;
};

type VectorSyncStatus = {
  mode: SyncMode;
  submittedCount: number;
  deletedCount: number;
  documents: DocumentSyncStatus[];
};

type KeywordIndexStatus = {
  mode: "reconcile" | "skipped";
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  partial: boolean;
  errors: string[];
};

// Bedrock's per-document ingestion/deletion statuses that won't change on
// their own without another sync - anything else (STARTING, PENDING,
// IN_PROGRESS, DELETING, DELETE_IN_PROGRESS) is still in flight.
const TERMINAL_DOCUMENT_STATUSES = new Set([
  "INDEXED",
  "PARTIALLY_INDEXED",
  "FAILED",
  "NOT_FOUND",
  "IGNORED",
  "METADATA_PARTIALLY_INDEXED",
  "METADATA_UPDATE_FAILED",
]);
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

  const [vectorSync, setVectorSync] = useState<VectorSyncStatus | null>(null);
  const [vectorSyncError, setVectorSyncError] = useState<string | null>(null);
  const [isVectorSyncPolling, setIsVectorSyncPolling] = useState(false);
  const [keywordIndex, setKeywordIndex] = useState<KeywordIndexStatus | null>(null);
  const [keywordIndexError, setKeywordIndexError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isKeywordIndexSyncing, setIsKeywordIndexSyncing] = useState(false);
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

  async function pollDocumentStatuses(keys: string[]) {
    if (keys.length === 0) {
      setIsVectorSyncPolling(false);
      return;
    }

    const res = await fetch(`/api/admin/kb/sync?keys=${encodeURIComponent(keys.join(","))}`);
    if (!res.ok) {
      setIsVectorSyncPolling(false);
      return;
    }

    const { documents } = (await res.json()) as { documents: DocumentSyncStatus[] };
    setVectorSync((current) => (current ? { ...current, documents } : current));

    const stillPending = documents.some(
      (doc) => !doc.status || !TERMINAL_DOCUMENT_STATUSES.has(doc.status),
    );
    if (stillPending) {
      setTimeout(() => pollDocumentStatuses(keys), POLL_INTERVAL_MS);
    } else {
      setIsVectorSyncPolling(false);
    }
  }

  // The keyword-index reconcile is time-budgeted server-side and reports
  // `partial: true` when it had to checkpoint instead of finishing. Keep
  // resuming it until it reports a full pass, so a large knowledge base's
  // first sync completes as several small requests instead of timing out as
  // one big one. Vector sync (tenant-scoped IngestKnowledgeBaseDocuments)
  // only ever fires on the initial, non-resume request - see the route.
  async function runSync(mode: SyncMode, resumeOnly: boolean) {
    setIsKeywordIndexSyncing(true);
    try {
      const res = await fetch("/api/admin/kb/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resumeOnly ? { resumeKeywordIndexOnly: true } : { mode }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setSyncError(
          typeof data?.error === "string" ? data.error : "Failed to start sync.",
        );
        return;
      }

      const {
        keywordIndex: newKeywordIndex,
        keywordIndexError: newKeywordIndexError,
        vectorSync: newVectorSync,
        vectorSyncError: newVectorSyncError,
      } = await res.json();
      setKeywordIndex(newKeywordIndex ?? null);
      setKeywordIndexError(newKeywordIndexError ?? null);

      if (!resumeOnly) {
        setVectorSync(newVectorSync ?? null);
        setVectorSyncError(newVectorSyncError ?? null);
        const keys: string[] = newVectorSync?.documents?.map((doc: DocumentSyncStatus) => doc.key) ?? [];
        if (keys.length > 0) {
          setIsVectorSyncPolling(true);
          pollDocumentStatuses(keys);
        }
      }

      if (newKeywordIndex?.partial && newKeywordIndex.mode === "reconcile" && !newKeywordIndexError) {
        await runSync(mode, true);
      }
    } finally {
      setIsKeywordIndexSyncing(false);
    }
  }

  async function handleSync(mode: SyncMode) {
    setSyncError(null);
    setVectorSync(null);
    setVectorSyncError(null);
    setKeywordIndex(null);
    setKeywordIndexError(null);
    setIsSyncing(true);
    try {
      await runSync(mode, false);
    } finally {
      setIsSyncing(false);
    }
  }

  const syncing = isSyncing || isKeywordIndexSyncing || isVectorSyncPolling;
  const failedDocumentCount =
    vectorSync?.documents.filter((doc) => doc.status === "FAILED").length ?? 0;

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
              organization. Documents are stored in shared infrastructure,
              scoped to your organization by access control.
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
            completes. Both options only ever touch your organization&apos;s
            own documents. &quot;Sync uploaded docs&quot; is the fast path -
            it only indexes what&apos;s new, changed, or removed since the
            last sync. &quot;Full sync&quot; re-indexes every document you
            have, useful if something looks out of date.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleSync("incremental")}
              disabled={syncing}
              className="w-fit"
            >
              {syncing ? "Syncing..." : "Sync uploaded docs"}
            </Button>
            <Button
              onClick={() => handleSync("full")}
              disabled={syncing}
              variant="outline"
              className="w-fit"
            >
              {syncing ? "Syncing..." : "Full sync"}
            </Button>
          </div>
          {syncError && <p className="text-sm text-destructive">{syncError}</p>}
          {keywordIndex && (
            <div className="text-sm text-muted-foreground">
              <p>
                Keyword index: {keywordIndex.mode === "skipped" ? "no supported S3 files" : "reconciled"}
                {keywordIndex.mode === "reconcile" &&
                  ` (${keywordIndex.indexedObjectCount} indexed, ${keywordIndex.indexedChunkCount} chunks, ${keywordIndex.unchangedObjectCount} unchanged, ${keywordIndex.deletedObjectCount} deleted)`}
                {keywordIndex.skippedObjectCount > 0 &&
                  `, skipped ${keywordIndex.skippedObjectCount}`}
                {keywordIndex.partial && ", partial scan"}
                {keywordIndex.errorCount > 0 && `, ${keywordIndex.errorCount} errors`}
                .
              </p>
              {keywordIndex.mode === "reconcile" && (
                <p>
                  Listed {keywordIndex.listedObjectCount} supported S3 objects;
                  {` ${keywordIndex.changedObjectCount} changed or new`}.
                </p>
              )}
              {keywordIndex.errors.length > 0 && (
                <ul className="mt-2 max-h-24 list-disc overflow-y-auto pl-5 font-mono text-xs text-destructive">
                  {keywordIndex.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {keywordIndexError && (
            <p className="text-sm text-destructive">
              Keyword index update failed: {keywordIndexError}
            </p>
          )}
          {vectorSync && (
            <div className="text-sm text-muted-foreground">
              <p>
                Vector index ({vectorSync.mode}): submitted{" "}
                {vectorSync.submittedCount}, deleted {vectorSync.deletedCount}
                {failedDocumentCount > 0 && `, ${failedDocumentCount} failed`}
                {isVectorSyncPolling ? " - indexing..." : "."}
              </p>
              {failedDocumentCount > 0 && (
                <ul className="mt-2 max-h-24 list-disc overflow-y-auto pl-5 font-mono text-xs text-destructive">
                  {vectorSync.documents
                    .filter((doc) => doc.status === "FAILED")
                    .map((doc) => (
                      <li key={doc.key}>
                        {doc.key}
                        {doc.statusReason ? `: ${doc.statusReason}` : ""}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          {vectorSyncError && (
            <p className="text-sm text-destructive">
              Vector index update failed: {vectorSyncError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
