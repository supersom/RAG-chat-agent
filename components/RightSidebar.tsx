"use client";

import React, { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { FileIcon, MessageCircleIcon } from "lucide-react";
import FullSourceModal from "./FullSourceModal";

interface RAGSource {
  id: string;
  fileName: string;
  snippet: string;
  score: number;
  timestamp?: string;
}

interface RAGHistoryItem {
  sources: RAGSource[];
  timestamp: string;
  query: string;
  userLabel?: string;
  // Shared with the assistant message that produced these sources (see
  // ChatArea's fetch handler), so an inline "[N]" citation in that message
  // can link to this exact turn's Nth source, not just whatever's most
  // recently in the sidebar.
  turnId?: string;
}

interface DebugInfo {
  context_used: boolean;
}

interface SidebarEvent {
  id: string;
  content: string;
  user_mood?: string;
  debug?: DebugInfo;
}

type LogMetadata = Record<string, string | number | boolean | null>;

interface LogEvent {
  id: string;
  timestamp?: number;
  message?: string;
  userLabel?: string;
  level?: "debug" | "info" | "warn" | "error";
  metadata?: LogMetadata;
}

type ActivityRecord = {
  activityId: string;
  kind: "chat_turn" | "app_log";
  createdAt: string;
  userEmail?: string;
  userId: string;
  chat?: { userMessage: string };
  knowledgeBase?: { contextUsed: boolean; sources: RAGSource[] };
  appLog?: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    route?: string;
    metadata?: LogMetadata;
  };
};

function userLabel(
  activity: Pick<ActivityRecord, "userEmail" | "userId">,
): string {
  return activity.userEmail || activity.userId;
}

function ragHistoryFromActivities(
  activities: ActivityRecord[],
): RAGHistoryItem[] {
  return activities
    .filter(
      (activity) =>
        activity.kind === "chat_turn" &&
        activity.knowledgeBase?.contextUsed &&
        activity.knowledgeBase.sources.length > 0,
    )
    .slice(0, MAX_HISTORY)
    .reverse()
    .map((activity) => ({
      sources: activity.knowledgeBase!.sources.map((source) => ({
        ...source,
        snippet: source.snippet || "No preview available",
        fileName:
          (source.fileName || "").replace(/_/g, " ").replace(".txt", "") ||
          "Unnamed",
        timestamp: activity.createdAt,
      })),
      timestamp: activity.createdAt,
      query: activity.chat?.userMessage || "Unknown query",
      userLabel: userLabel(activity),
    }));
}

function logEventsFromActivities(activities: ActivityRecord[]): LogEvent[] {
  return activities
    .filter((activity) => activity.kind === "app_log" && activity.appLog)
    .map((activity) => ({
      id: activity.activityId,
      timestamp: Date.parse(activity.createdAt),
      level: activity.appLog!.level,
      userLabel: userLabel(activity),
      message: `${activity.appLog!.route || "app"}: ${activity.appLog!.message}`,
      metadata: activity.appLog!.metadata,
    }));
}

function formatMetadataValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function formatLogMetadata(metadata?: LogMetadata): string[] {
  if (!metadata) return [];

  return Object.entries(metadata)
    .filter(([, value]) => value !== "" && value !== null)
    .map(([key, value]) => `${key}=${formatMetadataValue(value)}`);
}

const truncateSnippet = (text: string): string => {
  return text?.length > 150 ? `${text.slice(0, 100)}...` : text || "";
};

const getScoreColor = (score: number): string => {
  if (score > 0.6) return "bg-green-100 text-green-800";
  if (score > 0.4) return "bg-yellow-100 text-yellow-800";
  return "bg-red-100 text-red-800";
};

const getLogColor = (message: string): string => {
  const m = message.toLowerCase();
  if (m.includes("error") || m.includes("💥") || m.includes("❌"))
    return "text-red-500";
  if (m.includes("warn") || m.includes("🚨")) return "text-yellow-500";
  return "text-foreground";
};

const MAX_HISTORY = 15;
const POLL_INTERVAL_MS = 5000;

const RightSidebar: React.FC = () => {
  const { data: session } = useSession();
  const canViewLogs = session?.user?.role === "admin";
  const [activeTab, setActiveTab] = useState<"kb" | "logs">("kb");

  // KB history state
  const [ragHistory, setRagHistory] = useState<RAGHistoryItem[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<RAGSource | null>(null);

  // Logs state
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const kbEndRef = useRef<HTMLDivElement>(null);
  const logsTopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (session?.user) return;
    setRagHistory([]);
    setLogs([]);
  }, [session?.user]);

  useEffect(() => {
    if (!session?.user) return;

    let cancelled = false;
    const loadActivity = async () => {
      try {
        const response = await fetch("/api/activity?limit=100");
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        const activities: ActivityRecord[] = data.activities ?? [];
        setRagHistory(ragHistoryFromActivities(activities));
        if (canViewLogs) {
          setLogs(logEventsFromActivities(activities));
          setLogsError(null);
        }
      } catch (error: any) {
        if (canViewLogs) {
          setLogsError(error.message);
        }
      }
    };

    loadActivity();
    return () => {
      cancelled = true;
    };
  }, [canViewLogs, session?.user]);

  useEffect(() => {
    const updateRAGSources = (
      event: CustomEvent<{
        sources: RAGSource[];
        query: string;
        debug?: DebugInfo;
        turnId?: string;
      }>,
    ) => {
      const { sources, query, debug, turnId } = event.detail;
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        !debug?.context_used
      )
        return;

      const cleanedSources = sources.map((source) => ({
        ...source,
        snippet: source.snippet || "No preview available",
        fileName:
          (source.fileName || "").replace(/_/g, " ").replace(".txt", "") ||
          "Unnamed",
        timestamp: new Date().toISOString(),
      }));

      setRagHistory((prev) =>
        [
          ...prev,
          {
            sources: cleanedSources,
            timestamp: new Date().toISOString(),
            query: query || "Unknown query",
            turnId,
          },
        ].slice(-MAX_HISTORY),
      );
    };

    const updateDebug = (_event: CustomEvent<SidebarEvent>) => {};

    window.addEventListener(
      "updateRagSources" as any,
      updateRAGSources as EventListener,
    );
    window.addEventListener(
      "updateSidebar" as any,
      updateDebug as EventListener,
    );
    return () => {
      window.removeEventListener(
        "updateRagSources" as any,
        updateRAGSources as EventListener,
      );
      window.removeEventListener(
        "updateSidebar" as any,
        updateDebug as EventListener,
      );
    };
  }, []);

  useEffect(() => {
    if (canViewLogs) {
      setActiveTab("logs");
    }
  }, [canViewLogs]);

  useEffect(() => {
    if (!canViewLogs || activeTab !== "logs") return;

    let cancelled = false;
    const fetchLogs = async () => {
      setLogsLoading(true);
      try {
        const res = await fetch("/api/activity?kind=app_log&limit=100");
        const data = await res.json();
        if (cancelled) return;
        if (data.error) {
          setLogsError(data.error);
        } else {
          setLogs(logEventsFromActivities(data.activities ?? []));
          setLogsError(null);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLogsError(e.message);
        }
      } finally {
        if (!cancelled) {
          setLogsLoading(false);
        }
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeTab, canViewLogs]);

  useEffect(() => {
    if (activeTab === "kb") {
      kbEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [ragHistory, activeTab]);

  useEffect(() => {
    if (activeTab === "logs") {
      logsTopRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [logs, activeTab]);

  const handleViewFullSource = (source: RAGSource) => {
    setSelectedSource(source);
    setIsModalOpen(true);
  };

  const fadeInUpClass = "animate-fade-in-up";
  const fadeStyle = {
    animationDuration: "600ms",
    animationFillMode: "backwards" as const,
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  };

  return (
    <aside className="w-[380px] pr-4 overflow-hidden pb-4">
      <Card
        className={`${fadeInUpClass} h-full overflow-hidden flex flex-col`}
        style={fadeStyle}
      >
        <CardHeader className="pb-0">
          <div className="flex items-center gap-4 border-b">
            <button
              className={`text-sm font-medium pb-2 border-b-2 transition-colors ${
                activeTab === "kb"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("kb")}
            >
              Knowledge Base
            </button>
            {canViewLogs && (
              <button
                className={`text-sm font-medium pb-2 border-b-2 transition-colors ${
                  activeTab === "logs"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab("logs")}
              >
                Activity Logs
              </button>
            )}
          </div>
        </CardHeader>

        <CardContent className="overflow-y-auto flex-1 pt-4">
          {activeTab === "kb" && (
            <>
              {ragHistory.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  The assistant will display sources here once finding them
                </div>
              )}
              {ragHistory.map((historyItem, index) => (
                <div
                  key={historyItem.timestamp}
                  className={`mb-6 ${fadeInUpClass}`}
                  style={{ ...fadeStyle, animationDelay: `${index * 50}ms` }}
                >
                  <div className="flex items-center text-xs text-muted-foreground mb-2 gap-1">
                    <MessageCircleIcon
                      size={14}
                      className="text-muted-foreground"
                    />
                    {historyItem.userLabel && (
                      <span className="font-medium">
                        {historyItem.userLabel}
                      </span>
                    )}
                    <span>{historyItem.query}</span>
                  </div>
                  {historyItem.sources.map((source, sourceIndex) => (
                    <Card
                      key={source.id}
                      id={
                        historyItem.turnId
                          ? `source-${historyItem.turnId}-${sourceIndex}`
                          : undefined
                      }
                      className={`mb-2 scroll-mt-4 target:ring-2 target:ring-primary ${fadeInUpClass}`}
                      style={{
                        ...fadeStyle,
                        animationDelay: `${index * 100 + sourceIndex * 75}ms`,
                      }}
                    >
                      <CardContent className="py-4">
                        <p className="text-sm text-muted-foreground">
                          {truncateSnippet(source.snippet)}
                        </p>
                        <div className="flex flex-col gap-2">
                          <div
                            className={`${getScoreColor(source.score)} px-2 py-1 mt-4 rounded-full text-xs inline-block w-fit`}
                          >
                            {(source.score * 100).toFixed(0)}% match
                          </div>
                          <div
                            className="inline-flex items-center mr-2 mt-2 text-muted-foreground text-xs py-0 cursor-pointer hover:text-gray-600"
                            onClick={() => handleViewFullSource(source)}
                          >
                            <FileIcon className="w-4 h-4 min-w-[12px] min-h-[12px] mr-2" />
                            <span className="text-xs underline">
                              {truncateSnippet(source.fileName || "Unnamed")}
                            </span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ))}
              <div ref={kbEndRef} />
            </>
          )}

          {canViewLogs && activeTab === "logs" && (
            <div className="flex flex-col gap-1">
              <div ref={logsTopRef} />
              {logsError && (
                <div className="text-xs text-red-500 mb-2">
                  Error: {logsError}
                </div>
              )}
              {logs.length === 0 && !logsLoading && !logsError && (
                <div className="text-sm text-muted-foreground">
                  No persisted activity logs yet. Polling every 5s.
                </div>
              )}
              {logs.map((event) => {
                const metadata = formatLogMetadata(event.metadata);

                return (
                  <div
                    key={event.id}
                    className="font-mono text-xs leading-relaxed"
                  >
                    <div>
                      <span className="text-muted-foreground mr-2">
                        {event.timestamp
                          ? new Date(event.timestamp).toLocaleTimeString()
                          : ""}
                      </span>
                      {event.userLabel && (
                        <span className="text-muted-foreground mr-2">
                          {event.userLabel}
                        </span>
                      )}
                      <span className={getLogColor(event.message ?? "")}>
                        {event.message ?? ""}
                      </span>
                    </div>
                    {metadata.length > 0 && (
                      <div className="ml-16 break-words text-[11px] text-muted-foreground">
                        {metadata.join(" | ")}
                      </div>
                    )}
                  </div>
                );
              })}
              {logsLoading && logs.length === 0 && (
                <div className="text-xs text-muted-foreground">Loading…</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <FullSourceModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        source={selectedSource}
      />
    </aside>
  );
};

export default RightSidebar;
