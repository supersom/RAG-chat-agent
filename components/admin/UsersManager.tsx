"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";

interface SafeUser {
  userId: string;
  email: string;
  role: "admin" | "end_user";
  tenantId: string;
  createdAt: string;
}

export default function UsersManager() {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "end_user">("end_user");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function loadUsers() {
    setIsLoading(true);
    setListError(null);
    const res = await fetch("/api/admin/users");
    if (!res.ok) {
      setListError("Failed to load users.");
      setIsLoading(false);
      return;
    }
    const data = await res.json();
    setUsers(data.users);
    setIsLoading(false);
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setFormError(
        data?.error && typeof data.error === "string"
          ? data.error
          : "Could not add user.",
      );
      return;
    }

    setEmail("");
    setPassword("");
    setRole("end_user");
    await loadUsers();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Everyone with an account under your organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}
          {listError && (
            <p className="text-sm text-destructive">{listError}</p>
          )}
          {!isLoading && !listError && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Role</th>
                    <th className="py-2 pr-4 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.userId} className="border-b last:border-0">
                      <td className="py-2 pr-4">{user.email}</td>
                      <td className="py-2 pr-4">{user.role}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {new Date(user.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a user</CardTitle>
          <CardDescription>
            Create another admin or end-user account under your organization.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="newUserEmail" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="newUserEmail"
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="newUserPassword"
                className="text-sm font-medium"
              >
                Password
              </label>
              <Input
                id="newUserPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="newUserRole" className="text-sm font-medium">
                Role
              </label>
              <select
                id="newUserRole"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as "admin" | "end_user")
                }
              >
                <option value="end_user">End user</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Adding..." : "Add user"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
