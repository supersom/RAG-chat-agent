// Next.js resolves the real "server-only" package via its own build pipeline;
// it isn't an installed npm dependency and can't be resolved outside of
// `next build`/`next dev`. This inert stub lets Vitest import modules that
// start with `import "server-only"` without needing that machinery.
export {};
