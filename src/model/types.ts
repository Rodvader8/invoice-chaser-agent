export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  /** JSON schema the answer must follow (sent to providers that support structured output). */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  purpose: string;
}

export interface ChatResponse {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ChatModel {
  readonly name: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}
