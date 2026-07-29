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
  partial: boolean;
};

type KeywordSyncJob = {
  tenantId: string;
  status: "queued" | "running" | "complete" | "failed";
  mode: SyncMode;
  startedAt: string;
  finishedAt: string | null;
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  errors: string[];
  failureMessage: string | null;
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

function mergeDocuments(
  existing: DocumentSyncStatus[],
  incoming: DocumentSyncStatus[],
): DocumentSyncStatus[] {
  const byKey = new Map(existing.map((doc) => [doc.key, doc]));
  for (const doc of incoming) byKey.set(doc.key, doc);
  return Array.from(byKey.values());
}

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
  const [isVectorSyncSubmitting, setIsVectorSyncSubmitting] = useState(false);
  const [isVectorSyncPolling, setIsVectorSyncPolling] = useState(false);
  // Accumulates every key ever submitted across a whole (possibly
  // multi-round, checkpointed) vector sync, so status polling covers keys
  // submitted in later resume rounds too, not just the first round's.
  const submittedKeysRef = useRef<Set<string>>(new Set());
  const isVectorSyncSubmittingRef = useRef(false);
  const [keywordSyncJob, setKeywordSyncJob] = useState<KeywordSyncJob | null>(null);
  // Enqueue-time failures (e.g. sendKeywordSyncJob throwing) never produce a
  // job row at all, so there's nothing for /keyword-status to ever poll and
  // surface - the route reports them as its own keywordEnqueueError field,
  // distinct from objectTrackingError. Kept separate from keywordSyncJob.failureMessage,
  // which covers a job that WAS enqueued and later failed inside the worker -
  // two structurally different failure points, not the same error.
  const [keywordEnqueueError, setKeywordEnqueueError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // State, not a ref, deliberately - matches the existing isVectorSyncPolling
  // pattern in this same file. A ref's mutation doesn't trigger a re-render,
  // so if this were a ref, clearing it after a failed /keyword-status poll
  // would leave `syncing` (computed below) permanently true from the user's
  // point of view - the Sync button would stay stuck on "Syncing..." with no
  // visible recovery, since nothing else in the component happens to trigger
  // a re-render afterward.
  const [isPollingKeywordJob, setIsPollingKeywordJob] = useState(false);
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

  // Watches Bedrock's own eventual status (STARTING -> INDEXED/FAILED/etc)
  // for every key submitted so far. Reads submittedKeysRef fresh each round
  // rather than a fixed key list, so keys submitted in a later checkpointed
  // resume round get picked up automatically; keeps polling as long as
  // either something's still non-terminal or submission is still ongoing
  // (more keys may still show up).
  async function pollDocumentStatuses() {
    const keys = Array.from(submittedKeysRef.current);
    if (keys.length === 0) {
      setIsVectorSyncPolling(false);
      return;
    }

    const res = await fetch("/api/admin/kb/sync/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    if (!res.ok) {
      setIsVectorSyncPolling(false);
      return;
    }

    const { documents } = (await res.json()) as { documents: DocumentSyncStatus[] };
    setVectorSync((current) =>
      current ? { ...current, documents: mergeDocuments(current.documents, documents) } : current,
    );

    const stillPending = documents.some(
      (doc) => !doc.status || !TERMINAL_DOCUMENT_STATUSES.has(doc.status),
    );
    if (stillPending || isVectorSyncSubmittingRef.current) {
      setTimeout(pollDocumentStatuses, POLL_INTERVAL_MS);
    } else {
      setIsVectorSyncPolling(false);
    }
  }

  function trackSubmittedKeys(vs: VectorSyncStatus) {
    for (const doc of vs.documents) submittedKeysRef.current.add(doc.key);
    setVectorSync((current) =>
      current
        ? { ...vs, documents: mergeDocuments(current.documents, vs.documents) }
        : vs,
    );
    if (!isVectorSyncPolling && submittedKeysRef.current.size > 0) {
      setIsVectorSyncPolling(true);
      pollDocumentStatuses();
    }
  }

  // Vector sync (tenant-scoped Ingest/DeleteKnowledgeBaseDocuments) is
  // checkpointed server-side too: a large tenant needs more batches than
  // Bedrock's real, account-wide rate limit can clear inside one request, so
  // `vectorSync.partial: true` means "call again to submit more" - same
  // resume shape as the keyword index, just a separate, independent chain.
  async function resumeVectorSync(mode: SyncMode) {
    isVectorSyncSubmittingRef.current = true;
    setIsVectorSyncSubmitting(true);
    try {
      const res = await fetch("/api/admin/kb/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeVectorSyncOnly: true, mode }),
      });
      if (!res.ok) return;

      const { vectorSync: newVectorSync, vectorSyncError: newVectorSyncError } = await res.json();
      if (newVectorSyncError) {
        setVectorSyncError(newVectorSyncError);
        return;
      }
      if (!newVectorSync) return;

      trackSubmittedKeys(newVectorSync);
      if (newVectorSync.partial) {
        await resumeVectorSync(mode);
      }
    } finally {
      isVectorSyncSubmittingRef.current = false;
      setIsVectorSyncSubmitting(false);
    }
  }

  const KEYWORD_JOB_POLL_INTERVAL_MS = 5000;

  async function pollKeywordSyncJob() {
    try {
      const res = await fetch("/api/admin/kb/sync/keyword-status");
      if (!res.ok) {
        setIsPollingKeywordJob(false);
        return;
      }

      const { job } = (await res.json()) as { job: KeywordSyncJob | null };
      setKeywordSyncJob(job);

      if (job && (job.status === "queued" || job.status === "running")) {
        setTimeout(pollKeywordSyncJob, KEYWORD_JOB_POLL_INTERVAL_MS);
      } else {
        setIsPollingKeywordJob(false);
      }
    } catch {
      // Network failure, malformed JSON, etc. - same recovery as the !res.ok
      // path: stop polling rather than leaving the Sync button stuck.
      setIsPollingKeywordJob(false);
    }
  }

  function startPollingKeywordSyncJob() {
    if (isPollingKeywordJob) return;
    setIsPollingKeywordJob(true);
    pollKeywordSyncJob();
  }

  async function runSync(mode: SyncMode) {
    try {
      const res = await fetch("/api/admin/kb/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
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
        keywordEnqueueError: newKeywordEnqueueError,
        vectorSync: newVectorSync,
        vectorSyncError: newVectorSyncError,
      } = await res.json();

      setVectorSyncError(newVectorSyncError ?? null);
      if (newVectorSync) {
        trackSubmittedKeys(newVectorSync);
        if (newVectorSync.partial) {
          resumeVectorSync(mode);
        }
      }

      // keywordEnqueueError and keywordIndex are independent now - an enqueue
      // can succeed even when the (unrelated) object-tracking diff step
      // failed, and vice versa. Only a real enqueue failure means no job was
      // ever created and there is therefore nothing to poll for; reading the
      // conflated field previously suppressed polling for jobs that were in
      // fact running.
      if (newKeywordEnqueueError) {
        setKeywordEnqueueError(newKeywordEnqueueError);
      } else if (newKeywordIndex) {
        startPollingKeywordSyncJob();
      }
    } catch {
      setSyncError("Failed to start sync.");
    }
  }

  async function handleSync(mode: SyncMode) {
    setSyncError(null);
    setVectorSync(null);
    setVectorSyncError(null);
    setKeywordSyncJob(null);
    setKeywordEnqueueError(null);
    submittedKeysRef.current = new Set();
    setIsSyncing(true);
    try {
      await runSync(mode);
    } finally {
      setIsSyncing(false);
    }
  }

  const syncing =
    isSyncing || isVectorSyncSubmitting || isVectorSyncPolling || isPollingKeywordJob;
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
            own documents. &quot;Sync unindexed docs&quot; is the fast path -
            it indexes anything new, changed, or not yet successfully
            indexed (including a file left over from an interrupted sync),
            and removes anything deleted. &quot;Full sync&quot; re-indexes
            every document you have, useful if something looks out of date.
            A large knowledge base may take several rounds to finish -
            keep this page open until it reports done.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleSync("incremental")}
              disabled={syncing}
              className="w-fit"
            >
              {syncing ? "Syncing..." : "Sync unindexed docs"}
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
          {keywordSyncJob && (
            <div className="text-sm text-muted-foreground">
              <p>
                Keyword index: {keywordSyncJob.status}
                {keywordSyncJob.status === "complete" &&
                  ` (${keywordSyncJob.indexedObjectCount} indexed, ${keywordSyncJob.indexedChunkCount} chunks, ${keywordSyncJob.unchangedObjectCount} unchanged, ${keywordSyncJob.deletedObjectCount} deleted)`}
                {keywordSyncJob.skippedObjectCount > 0 &&
                  `, skipped ${keywordSyncJob.skippedObjectCount}`}
                {keywordSyncJob.errorCount > 0 && `, ${keywordSyncJob.errorCount} errors`}
              </p>
              {keywordSyncJob.status === "complete" && (
                <p>
                  Listed {keywordSyncJob.listedObjectCount} supported S3 objects;
                  {` ${keywordSyncJob.changedObjectCount} changed or new`}.
                </p>
              )}
              {keywordSyncJob.errors.length > 0 && (
                <ul className="list-disc pl-5">
                  {keywordSyncJob.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {keywordSyncJob?.status === "failed" && keywordSyncJob.failureMessage && (
            <p className="text-sm text-destructive">
              Keyword index update failed: {keywordSyncJob.failureMessage}
            </p>
          )}
          {keywordEnqueueError && (
            <p className="text-sm text-destructive">
              Keyword index sync failed to start: {keywordEnqueueError}
            </p>
          )}
          {vectorSync && (
            <div className="text-sm text-muted-foreground">
              <p>
                Vector index ({vectorSync.mode}): submitted{" "}
                {submittedKeysRef.current.size}, deleted {vectorSync.deletedCount}
                {failedDocumentCount > 0 && `, ${failedDocumentCount} failed`}
                {isVectorSyncSubmitting
                  ? " - submitting more..."
                  : isVectorSyncPolling
                    ? " - indexing..."
                    : "."}
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
