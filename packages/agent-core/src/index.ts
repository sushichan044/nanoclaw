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

export interface AgentSdkLogEntry {
  ts: string;
  seq: number;
  type: string;
  subtype?: string;
  session_id?: string;
  tool_name?: string;
  tool_input_preview?: string;
  text_preview?: string;
  result_preview?: string;
  task_id?: string;
  task_status?: string;
  task_summary?: string;
}

export interface AgentSdkLogger {
  write(entry: AgentSdkLogEntry): void;
}

export function buildSdkLogEntry(sdkMsg: unknown, seq: number): AgentSdkLogEntry {
  const msg = sdkMsg as Record<string, unknown>;
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const subtype = typeof msg.subtype === "string" ? msg.subtype : undefined;

  const entry: AgentSdkLogEntry = {
    ts: new Date().toISOString(),
    seq,
    type,
    ...(subtype !== undefined && { subtype }),
  };

  if (type === "system" && subtype === "init" && typeof msg.session_id === "string") {
    entry.session_id = msg.session_id;
  }

  if (type === "system" && subtype === "task_notification") {
    if (typeof msg.task_id === "string") entry.task_id = msg.task_id;
    if (typeof msg.status === "string") entry.task_status = msg.status;
    if (typeof msg.summary === "string") entry.task_summary = msg.summary;
  }

  if (type === "assistant") {
    const assistantMsg = msg.message as Record<string, unknown> | undefined;
    const content = assistantMsg?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          entry.text_preview = block.text.slice(0, 200);
          break;
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          entry.tool_name = block.name;
          entry.tool_input_preview = JSON.stringify(block.input ?? {}).slice(0, 200);
          break;
        }
      }
    }
  }

  if (type === "result" && typeof msg.result === "string") {
    entry.result_preview = msg.result.slice(0, 300);
  }

  return entry;
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
  sdkLogger?: AgentSdkLogger;
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
  let seq = 0;

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
    options.sdkLogger?.write(buildSdkLogEntry(message, seq++));

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
