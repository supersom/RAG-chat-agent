import { z } from "zod";
import { retrieveContext, RAGSource } from "@/app/lib/utils";
import crypto from "crypto";
import customerSupportCategories from "@/app/lib/customer_support_categories.json";
import { resolveTenantContext, isTenantResolutionError } from "@/app/lib/tenant";
import { applyGuardrail, GuardrailResult } from "@/app/lib/guardrails";
import { resolveLlmConfig } from "@/app/lib/llm-config";
import { auth } from "@/auth";
import { putAppLogActivity, putChatTurnActivity } from "@/app/lib/db/activity";
import { ActivityLlmProvider } from "@/app/lib/db/schema";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ActivityActor = {
  tenantId: string;
  userId: string;
  userEmail?: string;
  userRole: "admin" | "end_user";
};

function sanitizeActivityText(value: unknown, maxLength = 4000): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLength);
}

async function persistChatActivity({
  actor,
  provider,
  model,
  userMessage,
  assistantMessage,
  assistantThinking,
  userMood,
  suggestedQuestions,
  matchedCategories,
  redirectToAgent,
  contextUsed,
  ragSources,
  guardrail,
}: {
  actor: ActivityActor | null;
  provider: ActivityLlmProvider;
  model: string;
  userMessage: string;
  assistantMessage?: string;
  assistantThinking?: string;
  userMood?: string;
  suggestedQuestions?: string[];
  matchedCategories?: string[];
  redirectToAgent?: { should_redirect: boolean; reason?: string };
  contextUsed: boolean;
  ragSources: RAGSource[];
  guardrail?: { inputBlocked?: boolean; outputBlocked?: boolean };
}) {
  if (!actor) return;

  try {
    await putChatTurnActivity({
      tenantId: actor.tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      userRole: actor.userRole,
      kind: "chat_turn",
      chat: {
        provider,
        model,
        userMessage: sanitizeActivityText(userMessage),
        assistantMessage: assistantMessage
          ? sanitizeActivityText(assistantMessage)
          : undefined,
        assistantThinking: assistantThinking
          ? sanitizeActivityText(assistantThinking)
          : undefined,
        userMood,
        suggestedQuestions,
        matchedCategories,
        redirectToAgent: redirectToAgent
          ? {
              shouldRedirect: redirectToAgent.should_redirect,
              reason: redirectToAgent.reason
                ? sanitizeActivityText(redirectToAgent.reason, 1000)
                : undefined,
            }
          : undefined,
        guardrail,
      },
      knowledgeBase: {
        contextUsed,
        sources: ragSources.map((source) => ({
          id: sanitizeActivityText(source.id, 500),
          fileName: sanitizeActivityText(source.fileName, 500),
          snippet: sanitizeActivityText(source.snippet, 2000),
          score: source.score,
        })),
      },
    });
  } catch (err) {
    console.error("Failed to persist chat activity:", err);
  }
}

async function persistAppLogActivity({
  actor,
  level,
  message,
  route,
  metadata,
}: {
  actor: ActivityActor | null;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  route: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  if (!actor) return;

  try {
    await putAppLogActivity({
      tenantId: actor.tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      userRole: actor.userRole,
      kind: "app_log",
      appLog: {
        level,
        message: sanitizeActivityText(message, 1000),
        route,
        metadata,
      },
    });
  } catch (err) {
    console.error("Failed to persist app log activity:", err);
  }
}

function normalizeOpenRouterModel(model: string): string {
  if (model === "auto" || model === "auto-beta") {
    return `openrouter/${model}`;
  }
  return model;
}

async function generateCompletion({
  provider,
  apiKey,
  model,
  messages,
}: {
  provider: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}) {
  if (provider === "anthropic") {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const anthropicMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    const message = await client.messages.create({
      model,
      max_tokens: 1000,
      system: system || undefined,
      messages: anthropicMessages,
      temperature: 0.3,
    });
    const textContent = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      choices: [{ message: { content: textContent } }],
    };
  }

  if (provider === "openrouter") {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.AUTH_URL ? { "HTTP-Referer": process.env.AUTH_URL } : {}),
        ...(process.env.COMPANY_NAME ? { "X-Title": process.env.COMPANY_NAME } : {}),
      },
      body: JSON.stringify({
        model: normalizeOpenRouterModel(model),
        max_tokens: 1000,
        messages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  const { completion } = await import("litellm");
  return (completion as any)({
    model,
    max_tokens: 1000,
    messages,
    temperature: 0.3,
    apiKey,
    response_format: { type: "json_object" },
  });
}

// Debug message helper function
// Input: message string and optional data object
// Output: JSON string with message, sanitized data, and timestamp
const debugMessage = (msg: string, data: any = {}) => {
  console.log(msg, data);
  const timestamp = new Date().toISOString().replace(/[^\x20-\x7E]/g, "");
  const safeData = JSON.parse(JSON.stringify(data));
  return JSON.stringify({ msg, data: safeData, timestamp });
};

// Define the schema for the AI response using Zod
// This ensures type safety and validation for the AI's output
const responseSchema = z.object({
  response: z.string(),
  thinking: z.string(),
  user_mood: z.enum([
    "positive",
    "neutral",
    "negative",
    "curious",
    "frustrated",
    "confused",
  ]),
  suggested_questions: z.array(z.string()),
  debug: z.object({
    context_used: z.boolean(),
  }),
  matched_categories: z.array(z.string()).optional(),
  redirect_to_agent: z
    .object({
      should_redirect: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

// Helper function to sanitize header values
// Input: string value
// Output: sanitized string (ASCII characters only)
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x00-\x7F]/g, "");
}

// Helper function to log timestamps for performance measurement
// Input: label string and start time
// Output: Logs the duration for the labeled operation
const logTimestamp = (label: string, start: number) => {
  const timestamp = new Date().toISOString();
  const time = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`⏱️ [${timestamp}] ${label}: ${time}s`);
};

// Main POST request handler
export async function POST(req: Request) {
  const apiStart = performance.now();
  const measureTime = (label: string) => logTimestamp(label, apiStart);

  // Extract and validate data from the request body
  const parseResult = chatRequestSchema.safeParse(await req.json());
  if (!parseResult.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { messages, model, apiKey: clientApiKey } = parseResult.data;

  const tenantResult = await resolveTenantContext(req);
  if (isTenantResolutionError(tenantResult)) {
    return Response.json(
      { error: tenantResult.error },
      { status: tenantResult.status },
    );
  }
  const tenant = tenantResult;
  const session = await auth();
  const actor: ActivityActor | null =
    session?.user?.id && session.user.tenantId === tenant.tenantId
      ? {
          tenantId: session.user.tenantId,
          userId: session.user.id,
          userEmail: session.user.email ?? undefined,
          userRole: session.user.role,
        }
      : null;

  let llmConfig;
  try {
    llmConfig = resolveLlmConfig(tenant.llmProviderDefaults, clientApiKey);
  } catch (err) {
    console.error("Failed to resolve LLM config:", err);
    await persistAppLogActivity({
      actor,
      level: "error",
      route: "/api/chat",
      message: "Failed to resolve LLM provider configuration",
      metadata: { error: sanitizeActivityText(err, 1000) },
    });
    return Response.json(
      { error: "Failed to resolve LLM provider configuration" },
      { status: 500 },
    );
  }
  if (!llmConfig) {
    await persistAppLogActivity({
      actor,
      level: "error",
      route: "/api/chat",
      message: "No LLM provider configured for this tenant",
    });
    return Response.json(
      { error: "No LLM provider configured for this tenant" },
      { status: 500 },
    );
  }

  const resolvedModel =
    model && llmConfig.allowedModels.includes(model)
      ? model
      : llmConfig.model;

  const latestMessage = messages[messages.length - 1].content;

  console.log("📝 Latest Query:", latestMessage);
  measureTime("User Input Received");

  // Prepare debug data
  const MAX_DEBUG_LENGTH = 1000;
  const debugData = sanitizeHeaderValue(
    debugMessage("🚀 API route called", {
      messagesReceived: messages.length,
      latestMessageLength: latestMessage.length,
    }),
  ).slice(0, MAX_DEBUG_LENGTH);

  // Screen the input with the guardrail before any further processing.
  // Fails closed: any error calling the guardrail blocks the request.
  let inputGuardrail: GuardrailResult;
  try {
    inputGuardrail = await applyGuardrail({
      text: latestMessage,
      source: "INPUT",
      guardrailId: tenant.guardrailId,
      guardrailVersion: tenant.guardrailVersion,
      credentials: tenant.awsCredentials,
    });
  } catch (err) {
    console.error("Guardrail (input) call failed, failing closed:", err);
    const guardrailFailureResponse = {
      id: crypto.randomUUID(),
      response: "Sorry, I'm unable to process that request right now.",
      thinking: "Guardrail check failed",
      user_mood: "neutral" as const,
      suggested_questions: [],
      debug: { context_used: false },
    };
    await persistAppLogActivity({
      actor,
      level: "error",
      route: "/api/chat",
      message: "Input guardrail call failed",
      metadata: { error: sanitizeActivityText(err, 1000) },
    });
    await persistChatActivity({
      actor,
      provider: llmConfig.provider,
      model: resolvedModel,
      userMessage: latestMessage,
      assistantMessage: guardrailFailureResponse.response,
      assistantThinking: guardrailFailureResponse.thinking,
      userMood: guardrailFailureResponse.user_mood,
      suggestedQuestions: guardrailFailureResponse.suggested_questions,
      contextUsed: false,
      ragSources: [],
      guardrail: { inputBlocked: true },
    });
    return Response.json(guardrailFailureResponse, { status: 200 });
  }
  if (inputGuardrail.blocked) {
    const blockedResponse = {
      id: crypto.randomUUID(),
      response: inputGuardrail.outputText,
      thinking: "Blocked by guardrail",
      user_mood: "neutral" as const,
      suggested_questions: [],
      debug: { context_used: false },
    };
    await persistChatActivity({
      actor,
      provider: llmConfig.provider,
      model: resolvedModel,
      userMessage: latestMessage,
      assistantMessage: blockedResponse.response,
      assistantThinking: blockedResponse.thinking,
      userMood: blockedResponse.user_mood,
      suggestedQuestions: blockedResponse.suggested_questions,
      contextUsed: false,
      ragSources: [],
      guardrail: { inputBlocked: true },
    });
    return Response.json(blockedResponse, { status: 200 });
  }

  // Initialize variables for RAG retrieval
  let retrievedContext = "";
  let isRagWorking = false;
  let ragSources: RAGSource[] = [];

  // Attempt to retrieve context from RAG
  try {
    console.log("🔍 Initiating RAG retrieval for query:", latestMessage);
    measureTime("RAG Start");
    const result = await retrieveContext(
      latestMessage,
      tenant.knowledgeBaseId,
      3,
      tenant.awsCredentials,
    );
    retrievedContext = result.context;
    isRagWorking = result.isRagWorking;
    ragSources = result.ragSources || [];

    if (!result.isRagWorking) {
      console.warn("🚨 RAG Retrieval failed but did not throw!");
    }

    measureTime("RAG Complete");
    console.log("🔍 RAG Retrieved:", isRagWorking ? "YES" : "NO");
    console.log(
      "✅ RAG retrieval completed successfully. Context:",
      retrievedContext.slice(0, 100) + "...",
    );
  } catch (error) {
    console.error("💀 RAG Error:", error);
    console.error("❌ RAG retrieval failed for query:", latestMessage);
    await persistAppLogActivity({
      actor,
      level: "error",
      route: "/api/chat",
      message: "RAG retrieval failed",
      metadata: { error: sanitizeActivityText(error, 1000) },
    });
    retrievedContext = "";
    isRagWorking = false;
    ragSources = [];
  }

  measureTime("RAG Total Duration");

  // Prepare categories context for the system prompt
  const USE_CATEGORIES = true;
  const categoryListString = customerSupportCategories.categories
    .map((c) => c.id)
    .join(", ");

  const categoriesContext = USE_CATEGORIES
    ? `
    To help with our internal classification of inquiries, we would like you to categorize inquiries in addition to answering them. We have provided you with ${customerSupportCategories.categories.length} customer support categories.
    Check if your response fits into any category and include the category IDs in your "matched_categories" array.
    The available categories are: ${categoryListString}
    If multiple categories match, include multiple category IDs. If no categories match, return an empty array.
  `
    : "";

  const companyName = process.env.COMPANY_NAME || "our";
  const systemPrompt = `You are acting as a customer support assistant chatbot for ${companyName} inside a chat window on a website. You are chatting with a human user who is asking for help. When responding to the user, aim to provide concise and helpful responses while maintaining a polite and professional tone.

  To help you answer the user's question, we have retrieved the following information for you from our knowledge base:
  ${isRagWorking ? `${retrievedContext}` : "No information found for this query."}

  Please provide responses that use the information you have been given. If no relevant information is available, let the user know and offer to connect them with a human agent.

  ${categoriesContext}

  You are the first point of contact for the user and should try to resolve their issue or provide relevant information. If you are unable to help the user or if the user explicitly asks to talk to a human, you can redirect them to a human agent for further assistance.
  
  To display your responses correctly, you must format your entire response as a valid JSON object with the following structure:
  {
      "thinking": "Brief explanation of your reasoning for how you should address the user's query",
      "response": "Your concise response to the user",
      "user_mood": "positive|neutral|negative|curious|frustrated|confused",
      "suggested_questions": ["Question 1?", "Question 2?", "Question 3?"],
      "debug": {
        "context_used": true|false
      },
      ${USE_CATEGORIES ? '"matched_categories": ["category_id1", "category_id2"],' : ""}
      "redirect_to_agent": {
        "should_redirect": boolean,
        "reason": "Reason for redirection (optional, include only if should_redirect is true)"
      }
    }

  Here are a few examples of how your response should look like:

  Example of a response without redirection to a human agent:
  {
    "thinking": "Providing relevant information from the knowledge base",
    "response": "Here's the information you requested...",
    "user_mood": "curious",
    "suggested_questions": ["How do I update my account?", "What are the payment options?"],
    "debug": {
      "context_used": true
    },
    "matched_categories": ["account_management", "billing"],
    "redirect_to_agent": {
      "should_redirect": false
    }
  }

  Example of a response with redirection to a human agent:
  {
    "thinking": "User request requires human intervention",
    "response": "I understand this is a complex issue. Let me connect you with a human agent who can assist you better.",
    "user_mood": "frustrated",
    "suggested_questions": [],
    "debug": {
      "context_used": false
    },
    "matched_categories": ["technical_support"],
    "redirect_to_agent": {
      "should_redirect": true,
      "reason": "Complex technical issue requiring human expertise"
    }
  }
  `

  function sanitizeAndParseJSON(jsonString : string) {
    // Replace newlines within string values
    const sanitized = jsonString.replace(/(?<=:\s*")(.|\n)*?(?=")/g, match => 
      match.replace(/\n/g, "\\n")
    );
  
    try {
      return JSON.parse(sanitized);
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      throw new Error("Invalid JSON response from AI");
    }
  }

  try {
    console.log(`🚀 Query Processing`);
    measureTime("Claude Generation Start");

    const litellmMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages.map((msg: any) => ({ role: msg.role, content: msg.content })),
    ];

    const response = await generateCompletion({
      provider: llmConfig.provider,
      model: resolvedModel,
      apiKey: llmConfig.apiKey,
      messages: litellmMessages,
    });

    measureTime("Claude Generation Complete");
    console.log("✅ Message generation completed");

    const textContent = response.choices[0].message.content ?? "";

    // Parse the JSON response
    let parsedResponse;
    try {
      parsedResponse = sanitizeAndParseJSON(textContent);
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      throw new Error("Invalid JSON response from AI");
    }

    const validatedResponse = responseSchema.parse(parsedResponse);
    let outputGuardrailBlocked = false;

    // Screen the output with the guardrail. Fails open: an error calling
    // the guardrail does not block an already-generated response.
    try {
      const outputGuardrail = await applyGuardrail({
        text: validatedResponse.response,
        source: "OUTPUT",
        guardrailId: tenant.guardrailId,
        guardrailVersion: tenant.guardrailVersion,
        credentials: tenant.awsCredentials,
      });
      if (outputGuardrail.blocked) {
        outputGuardrailBlocked = true;
        validatedResponse.response = outputGuardrail.outputText;
      }
    } catch (err) {
      console.error("Guardrail (output) call failed, failing open:", err);
      await persistAppLogActivity({
        actor,
        level: "error",
        route: "/api/chat",
        message: "Output guardrail call failed",
        metadata: { error: sanitizeActivityText(err, 1000) },
      });
    }

    const responseWithId = {
      id: crypto.randomUUID(),
      ...validatedResponse,
    };

    // Check if redirection to a human agent is needed
    if (responseWithId.redirect_to_agent?.should_redirect) {
      console.log("🚨 AGENT REDIRECT TRIGGERED!");
      console.log("Reason:", responseWithId.redirect_to_agent.reason);
    }

    await persistChatActivity({
      actor,
      provider: llmConfig.provider,
      model: resolvedModel,
      userMessage: latestMessage,
      assistantMessage: responseWithId.response,
      assistantThinking: responseWithId.thinking,
      userMood: responseWithId.user_mood,
      suggestedQuestions: responseWithId.suggested_questions,
      matchedCategories: responseWithId.matched_categories,
      redirectToAgent: responseWithId.redirect_to_agent,
      contextUsed: responseWithId.debug.context_used,
      ragSources,
      guardrail: { outputBlocked: outputGuardrailBlocked },
    });

    // Prepare the response object
    const apiResponse = new Response(JSON.stringify(responseWithId), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Add RAG sources to the response headers if available
    if (ragSources.length > 0) {
      apiResponse.headers.set(
        "x-rag-sources",
        sanitizeHeaderValue(JSON.stringify(ragSources)),
      );
    }

    // Add debug data to the response headers
    apiResponse.headers.set("X-Debug-Data", sanitizeHeaderValue(debugData));

    measureTime("API Complete");

    return apiResponse;
  } catch (error) {
    // Handle errors in AI response generation
    console.error("💥 Error in message generation:", error);
    const errorResponse = {
      response:
        "Sorry, there was an issue processing your request. Please try again later.",
      thinking: "Error occurred during message generation.",
      user_mood: "neutral" as const,
      debug: { context_used: false },
    };
    await persistAppLogActivity({
      actor,
      level: "error",
      route: "/api/chat",
      message: "Message generation failed",
      metadata: { error: sanitizeActivityText(error, 1000) },
    });
    await persistChatActivity({
      actor,
      provider: llmConfig.provider,
      model: resolvedModel,
      userMessage: latestMessage,
      assistantMessage: errorResponse.response,
      assistantThinking: errorResponse.thinking,
      userMood: errorResponse.user_mood,
      contextUsed: false,
      ragSources,
    });
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
