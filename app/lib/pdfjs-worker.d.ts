// pdfjs-dist doesn't publish a declaration file for this worker subpath
// (only its top-level `pdfjs-dist/legacy/build/pdf.mjs` entry is typed).
// We import it directly in kb-keyword-index.ts to work around a Next.js
// bundling gap - see ensurePdfWorkerHandler() there for why.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
