// kb-keyword-index.ts (pulled into this compilation via tsconfig's
// `include`) dynamically imports this pdfjs-dist submodule path, which
// ships no type declarations of its own. The root Next.js app's
// moduleResolution ("bundler") tolerates this; this worker's
// moduleResolution ("node" - the correct setting for a real Node.js Lambda
// runtime, not a bundler-oriented one) does not, and fails with TS7016
// under `strict` otherwise. Confirmed via a live tsc run, not assumed.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
