import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import TenantSettingsForm from "@/components/admin/TenantSettingsForm";
import { redactTenant } from "@/app/lib/tenant-redact";

export default async function AdminSettingsPage() {
  const session = await auth();

  if (!session || session.user.role !== "admin") {
    return (
      <p className="p-4 text-sm text-destructive">
        You must be signed in as an admin to view this page.
      </p>
    );
  }

  const tenant = await getTenant(session.user.tenantId);

  if (!tenant) {
    return (
      <p className="p-4 text-sm text-destructive">
        Tenant not found.
      </p>
    );
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <TenantSettingsForm tenant={redactTenant(tenant)} />
    </div>
  );
}
