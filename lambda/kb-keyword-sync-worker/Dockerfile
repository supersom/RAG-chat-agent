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
COPY lambda/kb-keyword-sync-worker/package.json lambda/kb-keyword-sync-worker/
RUN npm install --prefix lambda/kb-keyword-sync-worker
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
RUN npm prune --omit=dev --prefix lambda/kb-keyword-sync-worker

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
