import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

const chatJid = process.env.NANOCLAW_CHAT_JID ?? "";
const ipcDir = process.env.NANOCLAW_COORDINATOR_IPC_DIR ?? "";
const requestsDir = path.join(ipcDir, "requests");
const resultsDir = path.join(ipcDir, "results");

function pollResult(resPath: string, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(resPath)) {
        const data = JSON.parse(fs.readFileSync(resPath, "utf-8")) as {
          error: string | null;
          result: string;
        };
        try {
          fs.unlinkSync(resPath);
        } catch {
          /* ignore */
        }
        if (data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data.result);
        }
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Coordinator timed out"));
        return;
      }
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
  });
}

async function callCoordinator(tool: string, args: Record<string, string>): Promise<string> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  fs.mkdirSync(requestsDir, { recursive: true });
  const reqPath = path.join(requestsDir, `${requestId}.json`);
  const tempPath = `${reqPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ requestId, tool, args }));
  fs.renameSync(tempPath, reqPath);

  const resPath = path.join(resultsDir, `${requestId}.json`);
  return pollResult(resPath, Date.now() + 30_000);
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

const server = new McpServer({
  name: "coordinator",
  version: "1.0.0",
});

server.tool(
  "start_workspace",
  "Start a named workspace container to handle a task.",
  {
    name: z.string().describe("The workspace name to start"),
    prompt: z.string().describe("The initial task prompt for the workspace"),
  },
  async (args) => {
    try {
      return toolResult(
        await callCoordinator("start_workspace", { name: args.name, prompt: args.prompt, chatJid }),
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool(
  "send_to_workspace",
  "Send a message to a running workspace.",
  {
    name: z.string().describe("The workspace name to send a message to"),
    message: z.string().describe("The message to send"),
  },
  async (args) => {
    try {
      return toolResult(
        await callCoordinator("send_to_workspace", {
          name: args.name,
          message: args.message,
          chatJid,
        }),
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.tool("workspace_status", "List all workspaces and their current status.", {}, async () => {
  try {
    return toolResult(await callCoordinator("workspace_status", {}));
  } catch (err) {
    return toolError(err);
  }
});

server.tool(
  "stop_workspace",
  "Stop a running workspace.",
  { name: z.string().describe("The workspace name to stop") },
  async (args) => {
    try {
      return toolResult(await callCoordinator("stop_workspace", { name: args.name }));
    } catch (err) {
      return toolError(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
