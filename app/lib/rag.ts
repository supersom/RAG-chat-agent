import "server-only";

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  RetrieveCommandInput,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { searchKeywordIndex } from "@/app/lib/kb-keyword-index";
import type { RAGSource } from "@/app/lib/rag-types";

export type { RAGSource };

export function mergeSources(vectorSources: RAGSource[], keywordSources: RAGSource[], limit: number) {
  const merged = new Map<
    string,
    RAGSource & { vectorRank?: number; keywordRank?: number }
  >();

  vectorSources.forEach((source, index) => {
    const key = source.s3Uri || source.id;
    merged.set(key, { ...source, vectorRank: index + 1, retrievalType: "vector" });
  });

  keywordSources.forEach((source, index) => {
    const key = source.s3Uri || source.id;
    const existing = merged.get(key);
    if (existing) {
      // Multiple returned chunks can belong to the same document (e.g. a
      // dominant match for a narrow query) - keep the best (first-seen)
      // rank rather than letting a later, worse chunk overwrite it.
      if (existing.keywordRank === undefined) {
        existing.keywordRank = index + 1;
      }
      existing.snippet = existing.snippet || source.snippet;
      if (existing.vectorRank !== undefined) {
        existing.retrievalType = "vector";
      }
    } else {
      merged.set(key, { ...source, keywordRank: index + 1 });
    }
  });

  // RRF only makes sense once keyword search has actually contributed
  // results to fuse against. When it hasn't (disabled, or no matches),
  // fall back to the original semantic similarity score so the UI's
  // score-based color legend (calibrated for 0-1 cosine scores) still holds.
  const usingRRF = keywordSources.length > 0;

  return Array.from(merged.values())
    .map((source) => {
      let score = source.score;
      if (usingRRF) {
        const vectorBoost = source.vectorRank ? 1 / (60 + source.vectorRank) : 0;
        const keywordBoost = source.keywordRank ? 1 / (60 + source.keywordRank) : 0;
        score = vectorBoost + keywordBoost || source.score;
      }
      const { vectorRank, keywordRank, ...rest } = source;
      return { ...rest, score: Number(score.toFixed(6)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function retrieveContext(
  query: string,
  knowledgeBaseId: string,
  tenantId: string,
  n: number = 3,
  credentials?: { accessKeyId?: string; secretAccessKey?: string },
  region?: string,
  disableKeywordSearch?: boolean,
): Promise<{
  context: string;
  isRagWorking: boolean;
  ragSources: RAGSource[];
}> {
  const bedrockClient = new BedrockAgentRuntimeClient({
    region: region || process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-2",
    credentials: {
      accessKeyId: (credentials?.accessKeyId || process.env.BAWS_ACCESS_KEY_ID)!,
      secretAccessKey: (credentials?.secretAccessKey || process.env.BAWS_SECRET_ACCESS_KEY)!,
    },
  });

  try {
    if (!knowledgeBaseId) {
      console.error("knowledgeBaseId is not provided");
      return {
        context: "",
        isRagWorking: false,
        ragSources: [],
      };
    }

    const input: RetrieveCommandInput = {
      knowledgeBaseId: knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: n,
          filter: { equals: { key: "tenantId", value: tenantId } },
        },
      },
    };

    const command = new RetrieveCommand(input);
    const response = await bedrockClient.send(command);

    // Parse results
    const rawResults = response?.retrievalResults || [];
    const vectorSources: RAGSource[] = rawResults
      .filter((res: any) => res.content && res.content.text)
      .map((result: any, index: number) => {
        const uri = result?.location?.s3Location?.uri || "";
        const fileName = uri.split("/").pop() || `Source-${index}.txt`;

        return {
          id:
            result.metadata?.["x-amz-bedrock-kb-chunk-id"] || `chunk-${index}`,
          fileName: fileName.replace(/_/g, " ").replace(".txt", ""),
          snippet: result.content?.text || "",
          score: result.score || 0,
          retrievalType: "vector" as const,
          s3Uri: uri || undefined,
        };
      })
      .slice(0, n);

    let keywordSources: RAGSource[] = [];
    if (!disableKeywordSearch) {
      try {
        const dataSource = await getKbDataSource(knowledgeBaseId);
        if (dataSource) {
          keywordSources = await searchKeywordIndex({
            tenantId,
            knowledgeBaseId,
            bucketName: dataSource.bucketName,
            query,
            limit: n,
            credentials,
            region,
          });
        }
      } catch (err) {
        console.error("Keyword index search failed:", err);
      }
    }

    const ragSources = mergeSources(vectorSources, keywordSources, n);
    console.log("🔍 Parsed RAG Sources:", ragSources); // Debug log

    const context = ragSources
      .map((source) => {
        const retrievalLabel = source.retrievalType === "keyword" ? "keyword" : "vector";
        return `Source: ${source.fileName} (${retrievalLabel})\n${source.snippet}`;
      })
      .join("\n\n");

    return {
      context,
      isRagWorking: ragSources.length > 0,
      ragSources,
    };
  } catch (error) {
    console.error("RAG Error:", error);
    return { context: "", isRagWorking: false, ragSources: [] };
  }
}
