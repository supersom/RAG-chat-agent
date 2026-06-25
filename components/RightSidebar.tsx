"use client";

import React, { useState, useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { FileIcon, MessageCircleIcon } from "lucide-react";
import FullSourceModal from "./FullSourceModal";
import { loadSettings } from "@/components/SettingsModal";

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

interface LogEvent {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
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
  if (m.includes("error") || m.includes("💥") || m.includes("❌")) return "text-red-500";
  if (m.includes("warn") || m.includes("🚨")) return "text-yellow-500";
  return "text-foreground";
};

const MAX_HISTORY = 15;
const POLL_INTERVAL_MS = 5000;

const RightSidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"kb" | "logs">("kb");

  // KB history state
  const [ragHistory, setRagHistory] = useState<RAGHistoryItem[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<RAGSource | null>(null);

  // Logs state
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const lastTimestampRef = useRef<number>(Date.now() - 10 * 60 * 1000);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateRAGSources = (
      event: CustomEvent<{ sources: RAGSource[]; query: string; debug?: DebugInfo }>
    ) => {
      const { sources, query, debug } = event.detail;
      if (!Array.isArray(sources) || sources.length === 0 || !debug?.context_used) return;

      const cleanedSources = sources.map((source) => ({
        ...source,
        snippet: source.snippet || "No preview available",
        fileName: (source.fileName || "").replace(/_/g, " ").replace(".txt", "") || "Unnamed",
        timestamp: new Date().toISOString(),
      }));

      setRagHistory((prev) =>
        [{ sources: cleanedSources, timestamp: new Date().toISOString(), query: query || "Unknown query" }, ...prev].slice(0, MAX_HISTORY)
      );
    };

    const updateDebug = (_event: CustomEvent<SidebarEvent>) => {};

    window.addEventListener("updateRagSources" as any, updateRAGSources as EventListener);
    window.addEventListener("updateSidebar" as any, updateDebug as EventListener);
    return () => {
      window.removeEventListener("updateRagSources" as any, updateRAGSources as EventListener);
      window.removeEventListener("updateSidebar" as any, updateDebug as EventListener);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "logs") return;

    const settings = loadSettings();

    const fetchLogs = async () => {
      setLogsLoading(true);
      try {
        const res = await fetch("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amplifyAppId: settings.amplifyAppId || undefined,
            awsRegion: settings.awsRegion || undefined,
            bawsAccessKeyId: settings.bawsAccessKeyId || undefined,
            bawsSecretAccessKey: settings.bawsSecretAccessKey || undefined,
            startTime: lastTimestampRef.current,
          }),
        });
        const data = await res.json();
        if (data.error) {
          setLogsError(data.error);
        } else {
          const newEvents: LogEvent[] = data.events ?? [];
          if (newEvents.length > 0) {
            const maxTs = Math.max(...newEvents.map((e) => e.timestamp ?? 0));
            lastTimestampRef.current = maxTs + 1;
            setLogs((prev) => [...prev, ...newEvents].slice(-500));
            setLogsError(null);
          }
        }
      } catch (e: any) {
        setLogsError(e.message);
      } finally {
        setLogsLoading(false);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "logs") {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
      <Card className={`${fadeInUpClass} h-full overflow-hidden flex flex-col`} style={fadeStyle}>
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
            <button
              className={`text-sm font-medium pb-2 border-b-2 transition-colors ${
                activeTab === "logs"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab("logs")}
            >
              CloudWatch Logs
            </button>
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
                    <MessageCircleIcon size={14} className="text-muted-foreground" />
                    <span>{historyItem.query}</span>
                  </div>
                  {historyItem.sources.map((source, sourceIndex) => (
                    <Card
                      key={source.id}
                      className={`mb-2 ${fadeInUpClass}`}
                      style={{ ...fadeStyle, animationDelay: `${index * 100 + sourceIndex * 75}ms` }}
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
            </>
          )}

          {activeTab === "logs" && (
            <div className="flex flex-col gap-1">
              {logsError && (
                <div className="text-xs text-red-500 mb-2">Error: {logsError}</div>
              )}
              {logs.length === 0 && !logsLoading && !logsError && (
                <div className="text-sm text-muted-foreground">
                  No logs in the last 10 minutes. Polling every 5s…
                </div>
              )}
              {logs.map((event, i) => (
                <div key={i} className="font-mono text-xs leading-relaxed">
                  <span className="text-muted-foreground mr-2">
                    {event.timestamp
                      ? new Date(event.timestamp).toLocaleTimeString()
                      : ""}
                  </span>
                  <span className={getLogColor(event.message ?? "")}>
                    {event.message ?? ""}
                  </span>
                </div>
              ))}
              {logsLoading && logs.length === 0 && (
                <div className="text-xs text-muted-foreground">Loading…</div>
              )}
              <div ref={logsEndRef} />
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
