import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
        <LogoutButton />
      </nav>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
