"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-sm font-medium text-muted-foreground hover:text-foreground"
      onClick={() => signOut({ callbackUrl: "/admin/login" })}
    >
      Log out
    </Button>
  );
}
