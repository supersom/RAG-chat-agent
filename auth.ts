import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getUserByEmail, getUserByEmailAnyTenant } from "@/app/lib/db/users";
import { verifyPassword } from "@/app/lib/auth/passwords";
import authConfig from "./auth.config";

declare module "next-auth" {
  interface User {
    role: "admin" | "end_user";
    tenantId: string;
  }
  interface Session {
    user: {
      role: "admin" | "end_user";
      tenantId: string;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role: "admin" | "end_user";
    tenantId: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        tenantId: { label: "Tenant ID", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const tenantId = credentials?.tenantId as string | undefined;

        if (!email || !password) return null;

        const user = tenantId
          ? await getUserByEmail(tenantId, email)
          : await getUserByEmailAnyTenant(email);

        if (!user) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.userId,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
        };
      },
    }),
  ],
});
