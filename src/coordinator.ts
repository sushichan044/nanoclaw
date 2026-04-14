import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MessageStream, runAgentCore } from "@nanoclaw/agent-core";

import {
  ASSISTANT_NAME,
  COORDINATOR_IPC_DIR,
  COORDINATOR_MODEL,
  COORDINATOR_SESSION_DIR,
  CREDENTIAL_PROXY_PORT,
} from "./config.js";
import { detectAuthMode } from "./credential-proxy.js";
import { logger } from "./logger.js";
import type { WorkspaceManager } from "./workspace-manager.js";

interface CoordinatorRequest {
  requestId: string;
  tool: string;
  args: Record<string, string>;
}

interface CoordinatorResult {
  requestId: string;
  result: string;
  error: string | null;
}

export interface CoordinatorDeps {
  workspaceManager: WorkspaceManager;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
  setTyping?: (chatJid: string, typing: boolean) => Promise<void>;
}

function buildSystemPrompt(chatJid: string, workspaceManager: WorkspaceManager): string {
  const workspaces = workspaceManager.getWorkspaces(chatJid);
  const workspaceSummary =
    workspaces.length > 0
      ? workspaces.map((w) => `  - ${w.name}: ${w.status} (started ${w.startedAt})`).join("\n")
      : "  (none)";

  return `You are ${ASSISTANT_NAME}, a personal AI assistant.

You receive messages from the user and decide how to respond.
For simple questions or conversation, reply naturally in text.
For heavy tasks (file operations, code execution, research, long-running work), use start_workspace to launch a background workspace container. The workspace will send progress updates as it works.
Use send_to_workspace for follow-up instructions to a running workspace, workspace_status to check status, and stop_workspace to stop one.

<active_workspaces>
${workspaceSummary}
</active_workspaces>`;
}

export class Coordinator {
  private sessions = new Map<string, string>(); // chatJid → sessionId
  private ipcIntervals = new Map<string, NodeJS.Timeout>(); // chatJid → interval
  private authMode = detectAuthMode();

  constructor(private deps: CoordinatorDeps) {}

  private getIpcDir(chatJid: string): string {
    const sanitized = chatJid.replace(/[^a-z0-9_.-]/gi, "_");
    return path.join(COORDINATOR_IPC_DIR, sanitized);
  }

  private startIpcWatcher(chatJid: string, ipcDir: string): void {
    const requestsDir = path.join(ipcDir, "requests");
    const resultsDir = path.join(ipcDir, "results");
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    const interval = setInterval(() => {
      void this.processIpcRequests(chatJid, requestsDir, resultsDir);
    }, 100);
    this.ipcIntervals.set(chatJid, interval);
  }

  private stopIpcWatcher(chatJid: string): void {
    const interval = this.ipcIntervals.get(chatJid);
    if (interval) {
      clearInterval(interval);
      this.ipcIntervals.delete(chatJid);
    }
  }

  private async processIpcRequests(
    chatJid: string,
    requestsDir: string,
    resultsDir: string,
  ): Promise<void> {
    let files: string[];
    try {
      files = fs
        .readdirSync(requestsDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      const reqPath = path.join(requestsDir, file);
      let req: CoordinatorRequest;
      try {
        req = JSON.parse(fs.readFileSync(reqPath, "utf-8")) as CoordinatorRequest;
        fs.unlinkSync(reqPath);
      } catch {
        continue;
      }

      let result = "";
      let error: string | null = null;
      try {
        result = await this.executeIpcTool(chatJid, req.tool, req.args);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const resPath = path.join(resultsDir, `${req.requestId}.json`);
      const tempPath = `${resPath}.tmp`;
      const resultData: CoordinatorResult = { requestId: req.requestId, result, error };
      fs.writeFileSync(tempPath, JSON.stringify(resultData));
      fs.renameSync(tempPath, resPath);
    }
  }

  private async executeIpcTool(
    chatJid: string,
    tool: string,
    args: Record<string, string>,
  ): Promise<string> {
    switch (tool) {
      case "start_workspace": {
        const result = await this.deps.workspaceManager.startWorkspace(
          chatJid,
          args.name,
          args.prompt,
        );
        if (!result.ok) return `Failed to start workspace: ${result.error}`;
        return `Workspace "${args.name}" started.`;
      }
      case "send_to_workspace": {
        const sent = this.deps.workspaceManager.sendToWorkspace(chatJid, args.name, args.message);
        if (!sent) return `Workspace "${args.name}" is not running or not reachable.`;
        return `Message sent to workspace "${args.name}".`;
      }
      case "workspace_status": {
        const workspaces = this.deps.workspaceManager.getWorkspaces(chatJid);
        if (workspaces.length === 0) return "No active workspaces.";
        return workspaces
          .map(
            (w) =>
              `${w.name}: ${w.status} | started: ${w.startedAt}${w.lastActivity ? ` | last activity: ${w.lastActivity}` : ""}`,
          )
          .join("\n");
      }
      case "stop_workspace": {
        const stopped = this.deps.workspaceManager.stopWorkspace(chatJid, args.name);
        if (!stopped) return `Workspace "${args.name}" was not running.`;
        return `Workspace "${args.name}" stopped.`;
      }
      default:
        return `Unknown tool: ${tool}`;
    }
  }

  async processMessage(chatJid: string, formattedMessages: string): Promise<void> {
    await this.deps.setTyping?.(chatJid, true);

    const ipcDir = this.getIpcDir(chatJid);
    const sanitized = chatJid.replace(/[^a-z0-9_.-]/gi, "_");
    const sessionHome = path.join(COORDINATOR_SESSION_DIR, sanitized);
    fs.mkdirSync(sessionHome, { recursive: true });

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const coordinatorMcpPath = path.join(__dirname, "coordinator-mcp.js");

    const stream = new MessageStream();
    stream.push(formattedMessages);
    stream.end();

    this.startIpcWatcher(chatJid, ipcDir);

    try {
      const result = await runAgentCore(stream, {
        cwd: process.cwd(),
        sessionId: this.sessions.get(chatJid),
        onResult: async (text: string) => {
          await this.deps.sendMessage(chatJid, text);
        },
        sdkOptions: {
          model: COORDINATOR_MODEL,
          allowedTools: ["WebSearch", "WebFetch", "mcp__coordinator__*"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: buildSystemPrompt(chatJid, this.deps.workspaceManager),
          mcpServers: {
            coordinator: {
              command: "node",
              args: [coordinatorMcpPath],
              env: {
                NANOCLAW_CHAT_JID: chatJid,
                NANOCLAW_COORDINATOR_IPC_DIR: ipcDir,
              },
            },
          },
          env: {
            ...process.env,
            HOME: sessionHome,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`,
            ANTHROPIC_API_KEY: "placeholder",
            ...(this.authMode === "oauth" && { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }),
          },
          settings: { language: "Japanese" },
        },
      });

      if (result.newSessionId) {
        this.sessions.set(chatJid, result.newSessionId);
      }
    } catch (err) {
      logger.error({ chatJid, err }, "Coordinator agent error");
      await this.deps.sendMessage(
        chatJid,
        "Sorry, I encountered an error processing your message.",
      );
    } finally {
      this.stopIpcWatcher(chatJid);
      await this.deps.setTyping?.(chatJid, false);
    }
  }

  async handleWorkspaceProgress(
    chatJid: string,
    workspaceName: string,
    text: string,
  ): Promise<void> {
    const prefixed = `[${workspaceName}] ${text}`;
    await this.deps.sendMessage(chatJid, prefixed);
  }
}
