export interface Tenant {
  tenantId: string;
  name: string;
  knowledgeBaseId: string;
  llmProviderDefaults: {
    provider: string;
    model: string;
    allowedModels?: string[];
  };
  requireEndUserAuth: boolean;
  guardrailId: string;
  guardrailVersion: string;
  allowedOrigins?: string[];
  awsCredentialsSecretArn?: string;
  amplifyAppId?: string;
  awsRegion?: string;
  createdAt: string;
}

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  role: "admin" | "end_user";
  tenantId: string;
  createdAt: string;
}
