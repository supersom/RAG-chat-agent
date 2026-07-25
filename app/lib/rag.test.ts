import { describe, expect, it } from "vitest";
import { mergeSources } from "@/app/lib/rag";
import type { RAGSource } from "@/app/lib/rag-types";

function keywordSource(rank: number, s3Uri: string): RAGSource {
  return {
    id: `keyword:${rank}`,
    fileName: "doc.pdf",
    snippet: `chunk ${rank}`,
    score: 1 / rank,
    retrievalType: "keyword",
    s3Uri,
  };
}

function vectorSource(rank: number, s3Uri: string): RAGSource {
  return {
    id: `vector:${rank}`,
    fileName: "other.pdf",
    snippet: `chunk ${rank}`,
    score: 0.01,
    retrievalType: "vector",
    s3Uri,
  };
}

describe("mergeSources", () => {
  it("keeps a document's best keyword rank when multiple top chunks come from the same document", () => {
    const target = "s3://bucket/pdfs/target.pdf";
    // Three weak, unrelated vector matches (as Bedrock returns when nothing is truly relevant).
    const vectorSources = [
      vectorSource(1, "s3://bucket/pdfs/unrelated-a.pdf"),
      vectorSource(2, "s3://bucket/pdfs/unrelated-b.pdf"),
      vectorSource(3, "s3://bucket/pdfs/unrelated-c.pdf"),
    ];
    // All three keyword hits are chunks from the SAME dominant document, ranked 1-3.
    const keywordSources = [
      keywordSource(1, target),
      keywordSource(2, target),
      keywordSource(3, target),
    ];

    const merged = mergeSources(vectorSources, keywordSources, 3);

    expect(merged.some((source) => source.s3Uri === target)).toBe(true);
  });

  it("does not mislabel a keyword-only document as vector-retrieved", () => {
    const target = "s3://bucket/pdfs/target.pdf";
    const keywordSources = [keywordSource(1, target), keywordSource(2, target)];

    const merged = mergeSources([], keywordSources, 3);

    const result = merged.find((source) => source.s3Uri === target);
    expect(result?.retrievalType).toBe("keyword");
  });
});
