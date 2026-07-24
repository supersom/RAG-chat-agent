export type LlmProvider = "openai" | "anthropic" | "openrouter";

export interface Tenant {
  tenantId: string;
  name: string;
  knowledgeBaseId: string;
  llmProviderDefaults?: {
    provider?: LlmProvider;
    apiKeyCiphertext?: string;
    model?: string;
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


export type ActivityKind = "chat_turn" | "app_log";

export interface ActivityRecord {
  tenantId: string;
  createdAtActivityId: string;
  activityId: string;
  createdAt: string;
  expiresAt?: number;

  tenantUserId: string;
  userId: string;
  userEmail?: string;
  userRole: "admin" | "end_user";

  kind: ActivityKind;

  chat?: {
    clientMessageId?: string;
    model: string;
    provider: LlmProvider;
    userMessage: string;
    assistantMessage?: string;
    assistantThinking?: string;
    userMood?: string;
    suggestedQuestions?: string[];
    matchedCategories?: string[];
    redirectToAgent?: {
      shouldRedirect: boolean;
      reason?: string;
    };
    guardrail?: {
      inputBlocked?: boolean;
      outputBlocked?: boolean;
    };
  };

  knowledgeBase?: {
    contextUsed: boolean;
    sources: Array<{
      id: string;
      fileName: string;
      snippet: string;
      score: number;
    }>;
  };

  appLog?: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    requestId?: string;
    route?: string;
    metadata?: Record<string, string | number | boolean | null>;
  };
}
