export interface RAGSource {
  id: string;
  fileName: string;
  snippet: string;
  score: number;
  retrievalType?: "vector" | "keyword";
  s3Uri?: string;
}
