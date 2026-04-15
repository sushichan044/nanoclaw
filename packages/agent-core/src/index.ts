import type { SDKUserMessage, Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (msg !== undefined) yield msg;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Options for running the agent core.
 */
export interface AgentCoreOptions {
  cwd: string;
  sessionId?: string;
  resumeAt?: string;
  onResult?: (text: string) => void | Promise<void>;
  sdkOptions?: SDKOptions;
}

/**
 * Result of running the agent core.
 */
export interface AgentCoreResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
}

/**
 * Run the agent core with the given stream and options.
 * The caller is responsible for managing the stream lifecycle (push/end).
 * Returns the new session ID and last assistant UUID.
 */
export async function runAgentCore(
  stream: MessageStream,
  options: AgentCoreOptions,
): Promise<AgentCoreResult> {
  if (typeof options.sdkOptions?.settings === "string") {
    throw new Error(
      "sdkOptions.settings cannot be a string. It must be an object of type Settings.",
    );
  }

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: options.cwd,
      resume: options.sessionId,
      resumeSessionAt: options.resumeAt,
      ...options.sdkOptions,
      settings: {
        cleanupPeriodDays: 99999,
        language: "Japanese",
        ...(options.sdkOptions?.settings ?? {}),
      },
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      newSessionId = message.session_id;
    }

    if (message.type === "assistant" && "uuid" in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === "result") {
      const textResult = "result" in message ? (message as { result?: string }).result : null;
      if (textResult && options.onResult) {
        await options.onResult(textResult);
      }
    }
  }

  return { newSessionId, lastAssistantUuid };
}
