import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  RetrieveCommand: vi.fn().mockImplementation(function (input) {
    return { input };
  }),
}));

import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { mergeSources, retrieveContext } from "@/app/lib/rag";
import type { RAGSource } from "@/app/lib/rag-types";

const mockedRetrieveCommand = vi.mocked(RetrieveCommand);

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

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ retrievalResults: [] });
  mockedRetrieveCommand.mockClear();
});

describe("retrieveContext", () => {
  it("always includes a tenantId equality filter scoped to the passed tenant", async () => {
    await retrieveContext("what is my balance", "kb-123", "tenant-a", 3, undefined, undefined, true);

    expect(mockedRetrieveCommand).toHaveBeenCalledTimes(1);
    const input = mockedRetrieveCommand.mock.calls[0][0] as any;
    expect(input.retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
      equals: { key: "tenantId", value: "tenant-a" },
    });
  });

  it("scopes the filter to whichever tenantId is passed, not a hardcoded value", async () => {
    await retrieveContext("what is my balance", "kb-123", "tenant-b", 5, undefined, undefined, true);

    const input = mockedRetrieveCommand.mock.calls[0][0] as any;
    expect(input.retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
      equals: { key: "tenantId", value: "tenant-b" },
    });
  });

  it("numbers each source 1-indexed in the context string, matching ragSources' own order", async () => {
    sendMock.mockResolvedValue({
      retrievalResults: [
        {
          content: { text: "refunds take 5 days" },
          location: { s3Location: { uri: "s3://bucket/tenants/acme/refunds.pdf" } },
          score: 0.8,
        },
        {
          content: { text: "shipping takes 2 days" },
          location: { s3Location: { uri: "s3://bucket/tenants/acme/shipping.pdf" } },
          score: 0.7,
        },
      ],
    });

    const { context, ragSources } = await retrieveContext(
      "how long does shipping take",
      "kb-123",
      "tenant-a",
      3,
      undefined,
      undefined,
      true,
    );

    expect(context).toContain(`[1] Source: ${ragSources[0].fileName}`);
    expect(context).toContain(`[2] Source: ${ragSources[1].fileName}`);
  });
});

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

  it("uses the raw semantic score, not RRF, when keyword search contributed nothing", () => {
    const vectorSources = [
      { ...vectorSource(1, "s3://bucket/pdfs/a.pdf"), score: 0.72 },
    ];

    const merged = mergeSources(vectorSources, [], 3);

    expect(merged[0].score).toBe(0.72);
  });

  it("uses RRF fusion scores when keyword search did contribute results", () => {
    const target = "s3://bucket/pdfs/target.pdf";
    const vectorSources = [{ ...vectorSource(1, target), score: 0.72 }];
    const keywordSources = [keywordSource(1, target)];

    const merged = mergeSources(vectorSources, keywordSources, 3);

    expect(merged[0].score).toBeCloseTo(2 / 61, 6);
  });
});
