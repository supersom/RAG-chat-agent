import Link from "next/link";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { LogoutButton } from "@/components/LogoutButton";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const tenant =
    session?.user.role === "admin"
      ? await getTenant(session.user.tenantId)
      : null;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <nav className="flex items-center justify-between gap-6 border-b p-4">
        <div className="flex items-center gap-6">
          <span className="text-lg font-semibold tracking-tight">
            Admin Dashboard
          </span>
          <div className="flex items-center gap-4">
            <Link
              href="/admin"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Settings
            </Link>
            <Link
              href="/admin/embed"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Embed Snippet
            </Link>
            <Link
              href="/admin/users"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Users
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Go to Chat
          </Link>
          {tenant && (
            <span className="text-xs text-muted-foreground">
              Viewing: <span className="font-medium">{tenant.name}</span>{" "}
              <span className="font-mono">({tenant.tenantId})</span>
            </span>
          )}
          <LogoutButton />
        </div>
      </nav>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
