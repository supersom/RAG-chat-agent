import { loadSettings } from "@/components/SettingsModal";

export function getTenantToken(): string | null {
  const metaToken = document
    .querySelector('meta[name="tenant-token"]')
    ?.getAttribute("content");
  if (metaToken) return metaToken;

  if (process.env.NEXT_PUBLIC_APP_ENV === "development") {
    return loadSettings().tenantToken || null;
  }

  return null;
}
