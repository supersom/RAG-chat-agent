# lambda/kb-keyword-sync-worker/Dockerfile
#
# better-sqlite3 is a native module - building it inside this image (which
# matches the Lambda Node.js 20 runtime's actual OS/architecture) avoids the
# cross-compilation problems this project has hit before with native deps
# (see @napi-rs/canvas's DOMMatrix failures in DEVLOG.md). A zip-based
# deploy would need the native binary cross-compiled for Amazon Linux
# separately from this dev machine's own OS/arch - a container image sidesteps
# that entirely by compiling in the same environment the function runs in.
#
# Build context is the repo root (see the `docker build -f
# lambda/kb-keyword-sync-worker/Dockerfile .` command below) so this can
# COPY both lambda/kb-keyword-sync-worker/ and app/lib/ into the same image.
FROM public.ecr.aws/lambda/nodejs:20 AS build

# public.ecr.aws/lambda/nodejs:20 does NOT ship Python or a C/C++ toolchain
# by default - confirmed directly (not assumed): `npm install` fails with
# "gyp ERR! find Python - Could not find any Python installation to use"
# without this. `dnf` (present on this Amazon Linux 2023-based image) and
# these exact three packages were verified live: `dnf install -y python3 gcc
# gcc-c++ make` succeeds, and the resulting `python3`/`gcc`/`make` binaries
# run and report real versions (Python 3.9.25, GCC 11.5.0, GNU Make 4.3).
RUN dnf install -y python3 gcc gcc-c++ make && dnf clean all

WORKDIR /build
COPY lambda/kb-keyword-sync-worker/package.json lambda/kb-keyword-sync-worker/package-lock.json lambda/kb-keyword-sync-worker/
RUN npm ci --prefix lambda/kb-keyword-sync-worker

# better-sqlite3@13 ships "gypfile": false - npm install never triggers a
# node-gyp build at all, it just uses whichever prebuilt binary from its own
# bundled prebuilds/ directory matches the current platform (e.g.
# prebuilds/linux-x64.node). Confirmed live in production, the hard way: that
# generic prebuilt binary segfaults on Lambda's actual runtime
# ("Runtime.ExitError", "signal: segmentation fault") despite loading fine
# under `docker run` locally (require() alone doesn't exercise the native
# addon's real code paths - only actually opening a database does) and
# despite the dnf-installed python3/gcc/make toolchain above, which was
# necessary but not sufficient since nothing was invoking it. Forcing the
# package's own build-release script compiles a real binary against this
# exact container's toolchain/glibc instead, which is what the comment at
# the top of this file always intended "building it inside this image" to
# mean.
RUN cd lambda/kb-keyword-sync-worker/node_modules/better-sqlite3 && npm run build-release

COPY lambda/kb-keyword-sync-worker/tsconfig.json lambda/kb-keyword-sync-worker/handler.ts lambda/kb-keyword-sync-worker/db-client.ts lambda/kb-keyword-sync-worker/pdfjs-worker-types.d.ts lambda/kb-keyword-sync-worker/
# kb-keyword-index.ts imports from rag-types.ts (types only, erased at
# runtime) and bedrock-kb.ts (real runtime values - ingestKnowledgeBaseDocuments/
# deleteKnowledgeBaseDocuments - even though the worker's own code path never
# calls them, they share kb-keyword-index.ts's top-level imports with
# reconcileKeywordIndex, so the whole file needs to compile). Both were
# missing from this COPY in an earlier attempt - confirmed live via a real
# `tsc` error ("Cannot find module '@/app/lib/rag-types'"/'.../bedrock-kb'),
# not assumed.
COPY app/lib/kb-keyword-index.ts app/lib/rag-types.ts app/lib/bedrock-kb.ts app/lib/
COPY app/lib/db/keyword-sync-jobs.ts app/lib/db/client.ts app/lib/db/
RUN cd lambda/kb-keyword-sync-worker && npx tsc -p tsconfig.json

# tsc's CommonJS output ("module": "commonjs" in tsconfig.json) downlevels
# kb-keyword-index.ts's literal `await import("pdfjs-dist/legacy/build/
# pdf.worker.mjs")` into `Promise.resolve().then(() => require(...))` - a
# genuine require() of an ES Module in disguise, which Node always rejects
# ("require() of ES Module ... not supported"). Confirmed live in
# production: this only surfaces the instant a real PDF is actually
# extracted, which the Dockerfile's own build-time smoke test never
# exercised before (it only opened a `:memory:` SQLite database). Fixing
# the *source* was tried and rejected: every trick that hides the literal
# `import(...)` from tsc's static analysis (`new Function`, indirect
# `eval`) also hides it from Vitest's own module transform, breaking the
# test suite - both use the same mechanism (static detection of a literal
# import() expression) to work correctly, just for opposite outputs. Node
# itself has no problem executing a genuine `import(...)` expression
# directly inside a CommonJS .js file at runtime (only *static* import/
# export declarations are ESM-only) - so patching tsc's compiled output
# back to what the source actually said is safe and precise: it targets
# the exact downleveled pattern verbatim, not a general find/replace, and
# fails the build loudly if that pattern isn't found rather than silently
# doing nothing.
RUN cd /build/lambda/kb-keyword-sync-worker && \
    grep -q 'await Promise.resolve().then(() => __importStar(require("pdfjs-dist/legacy/build/pdf.worker.mjs")))' dist/app/lib/kb-keyword-index.js && \
    sed -i 's|await Promise.resolve().then(() => __importStar(require("pdfjs-dist/legacy/build/pdf.worker.mjs")))|await import("pdfjs-dist/legacy/build/pdf.worker.mjs")|' dist/app/lib/kb-keyword-index.js && \
    ! grep -q 'require("pdfjs-dist/legacy/build/pdf.worker.mjs")' dist/app/lib/kb-keyword-index.js

RUN npm prune --omit=dev --prefix lambda/kb-keyword-sync-worker

# server-only is a Next.js-only guard package (throws when imported outside
# a React Server Component) that kb-keyword-index.ts imports for its
# legitimate purpose in the Next.js app. tsc does not resolution-check
# side-effect-only imports at compile time, so this only surfaces as a real
# "Cannot find module 'server-only'" crash at actual container runtime -
# confirmed live by running the built image, not assumed. A harmless no-op
# stub (NOT the real npm package, which deliberately throws outside an RSC
# context) satisfies the require() without a bundler or path-rewriting tool.
# Injected after npm prune, not before: it isn't a declared dependency, so
# prune would otherwise remove it as extraneous.
RUN mkdir -p lambda/kb-keyword-sync-worker/node_modules/server-only && \
    printf '{"name":"server-only","version":"0.0.0","main":"index.js"}' > lambda/kb-keyword-sync-worker/node_modules/server-only/package.json && \
    printf '// no-op stub for the worker Lambda - see docs/superpowers/plans/2026-07-28-async-keyword-index-sync.md\n' > lambda/kb-keyword-sync-worker/node_modules/server-only/index.js

# Proves the handler can actually load AND that better-sqlite3's native
# binary actually works, not just that the module resolves - `require()`
# alone was exactly the check that missed the build-release fix above: it
# loads the native addon into memory fine even when the binary is
# incompatible with this environment, and only segfaults once real SQLite
# code actually runs. This is also the check that caught the earlier
# server-only/@/app/lib/bedrock-kb unresolvable-require bugs, which
# `tsc --noEmit` and `docker build` alone both passed cleanly through.
#
# Also exercises extractText() on a real (minimal, hand-built, but valid)
# PDF - closing the exact gap that let the pdf.worker.mjs require()-of-ESM
# bug (see the sed fixup above) ship undetected: nothing before this ever
# called extractText() at build time, only better-sqlite3. The PDF is
# inlined as base64 rather than COPYing a fixture file, to keep this
# self-contained; verified independently (outside Docker) that pdf-parse
# extracts "Hello PDF" from these exact bytes before relying on it here.
RUN node -e ' \
  (async () => { \
    require("./lambda/kb-keyword-sync-worker/dist/lambda/kb-keyword-sync-worker/handler.js"); \
    const Database = require("./lambda/kb-keyword-sync-worker/node_modules/better-sqlite3"); \
    const db = new Database(":memory:"); \
    db.exec("CREATE TABLE t (x INTEGER)"); \
    db.prepare("INSERT INTO t VALUES (1)").run(); \
    if (db.prepare("SELECT x FROM t").get().x !== 1) throw new Error("better-sqlite3 smoke test failed"); \
    db.close(); \
    console.log("better-sqlite3 native binary OK"); \
    const { extractText } = require("./lambda/kb-keyword-sync-worker/dist/app/lib/kb-keyword-index.js"); \
    const pdfB64 = "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L01lZGlhQm94WzAgMCAyMDAgMjAwXS9Db250ZW50cyA1IDAgUj4+ZW5kb2JqCjQgMCBvYmo8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PmVuZG9iago1IDAgb2JqPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAyMCAxMDAgVGQgKEhlbGxvIFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp0cmFpbGVyPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgolJUVPRgo="; \
    const text = await extractText(Buffer.from(pdfB64, "base64"), "smoke-test.pdf"); \
    if (!text.includes("Hello PDF")) throw new Error("extractText smoke test failed: got " + JSON.stringify(text)); \
    console.log("PDF text extraction OK"); \
  })().catch((err) => { \
    console.error(err); \
    process.exit(1); \
  }); \
'

# tsc's rootDir ("../..", i.e. the repo root) makes it mirror the full
# source path under dist/ - verified directly (not assumed): compiling this
# exact layout produces dist/lambda/kb-keyword-sync-worker/handler.js and
# dist/app/lib/kb-keyword-index.js as siblings, NOT a flattened dist/handler.js.
# handler.js's compiled `require("../../app/lib/kb-keyword-index")` only
# resolves correctly if that same nesting is preserved in the deployed
# image - so this copies dist/ whole, not flattened, and the Lambda handler
# path below includes the subdirectory.
FROM public.ecr.aws/lambda/nodejs:20
COPY --from=build /build/lambda/kb-keyword-sync-worker/dist ${LAMBDA_TASK_ROOT}
COPY --from=build /build/lambda/kb-keyword-sync-worker/node_modules ${LAMBDA_TASK_ROOT}/node_modules
CMD ["lambda/kb-keyword-sync-worker/handler.handler"]
