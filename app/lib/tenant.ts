import { SignJWT, jwtVerify } from "jose";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { Tenant } from "@/app/lib/db/schema";

export interface TenantEmbedTokenClaims {
  tenantId: string;
  allowedOrigins?: string[];
}

export async function signTenantToken(
  claims: TenantEmbedTokenClaims,
  options?: { expiresIn?: string },
): Promise<string> {
  let jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("tenant-embed");

  if (options?.expiresIn) {
    jwt = jwt.setExpirationTime(options.expiresIn);
  }

  return jwt.sign(new TextEncoder().encode(process.env.TENANT_JWT_SECRET));
}

export async function verifyTenantToken(
  token: string,
): Promise<TenantEmbedTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.TENANT_JWT_SECRET),
      { audience: "tenant-embed" },
    );
    return payload as unknown as TenantEmbedTokenClaims;
  } catch {
    return null;
  }
}

export type TenantContext = Tenant & {
  awsCredentials: { accessKeyId: string; secretAccessKey: string };
};

export type TenantResolutionError = { error: string; status: number };

export function isTenantResolutionError(
  x: TenantContext | TenantResolutionError,
): x is TenantResolutionError {
  return "status" in x;
}

export async function resolveTenantContext(
  req: Request,
): Promise<TenantContext | TenantResolutionError> {
  const token = req.headers.get("x-tenant-token");

  if (!token) {
    if (process.env.NODE_ENV === "development") {
      return {
        tenantId: "dev",
        name: "Development",
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID ?? "",
        llmProviderDefaults: {
          provider: "anthropic",
          model: process.env.DEFAULT_MODEL ?? "claude-3-5-sonnet-20240620",
        },
        requireEndUserAuth: false,
        guardrailId: process.env.BEDROCK_GUARDRAIL_ID ?? "",
        guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT",
        createdAt: new Date().toISOString(),
        awsCredentials: {
          accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
        },
      };
    }
    return { error: "Missing tenant token", status: 401 };
  }

  const claims = await verifyTenantToken(token);
  if (!claims) {
    return { error: "Invalid or expired tenant token", status: 401 };
  }

  if (claims.allowedOrigins?.length) {
    const origin = req.headers.get("origin");
    if (origin && !claims.allowedOrigins.includes(origin)) {
      return { error: "Origin not allowed", status: 403 };
    }
  }

  const tenant = await getTenant(claims.tenantId);
  if (!tenant) {
    return { error: "Unknown tenant", status: 404 };
  }

  if (tenant.requireEndUserAuth) {
    const session = await auth();
    if (!session || session.user.tenantId !== tenant.tenantId) {
      return { error: "Authentication required", status: 401 };
    }
  }

  if (tenant.awsCredentialsSecretArn) {
    console.warn(
      "Per-tenant AWS credential resolution not implemented this phase, falling back to shared credentials",
      tenant.tenantId,
    );
  }

  return {
    ...tenant,
    awsCredentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
  };
}
