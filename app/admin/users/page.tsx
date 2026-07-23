import { auth } from "@/auth";
import UsersManager from "@/components/admin/UsersManager";

export default async function AdminUsersPage() {
  const session = await auth();

  if (!session || session.user.role !== "admin") {
    return (
      <p className="p-4 text-sm text-destructive">
        You must be signed in as an admin to view this page.
      </p>
    );
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <UsersManager />
    </div>
  );
}
