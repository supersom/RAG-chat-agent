import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  createUser,
  getUserByEmailAnyTenant,
  getUsersByTenant,
} from "@/app/lib/db/users";
import { hashPassword } from "@/app/lib/auth/passwords";

const addUserSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(["admin", "end_user"]),
  })
  .strict();

export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await getUsersByTenant(session.user.tenantId);
  const sanitized = users.map(({ passwordHash: _passwordHash, ...user }) => user);

  return NextResponse.json({ users: sanitized });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = addUserSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { email, password, role } = parsed.data;

  const existingUser = await getUserByEmailAnyTenant(email);
  if (existingUser) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 },
    );
  }

  const user = await createUser({
    email,
    passwordHash: await hashPassword(password),
    role,
    tenantId: session.user.tenantId,
  });

  const { passwordHash: _passwordHash, ...sanitized } = user;
  return NextResponse.json(sanitized, { status: 201 });
}
