import { loadSettings } from "@/components/SettingsModal";

export function getTenantToken(): string | null {
  const metaToken = document
    .querySelector('meta[name="tenant-token"]')
    ?.getAttribute("content");
  if (metaToken) return metaToken;

  // Embed snippets (see app/admin/embed/page.tsx) deliver the token via
  // `?t=` on the iframe src since the embedding site can't inject a meta tag.
  const queryToken = new URLSearchParams(window.location.search).get("t");
  if (queryToken) return queryToken;

  if (process.env.NEXT_PUBLIC_APP_ENV === "development") {
    return loadSettings().tenantToken || null;
  }

  return null;
}
