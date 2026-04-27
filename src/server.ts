import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { loadConfig } from "./config.js";
import { SerialGroupChat } from "./group-chat.js";
import { PlaywrightWebModelSession } from "./web-session.js";

interface ServerOptions {
  configPath: string;
  host: string;
  port: number;
}

export async function startWebServer(options: ServerOptions): Promise<void> {
  const config = await loadConfig(options.configPath);
  const chat = new SerialGroupChat(config, {
    a: new PlaywrightWebModelSession(config.models.a, config.browser?.slowMoMs),
    b: new PlaywrightWebModelSession(config.models.b, config.browser?.slowMoMs)
  });

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 400, { error: "Missing URL." });
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(chat, request, response, url.pathname);
        return;
      }

      await serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  process.on("SIGINT", async () => {
    await chat.close();
    server.close();
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`Serial group chat UI: http://${options.host}:${options.port}`);
}

async function handleApi(chat: SerialGroupChat, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, chat.snapshot());
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (pathname === "/api/start") {
    const body = await readJson<{
      topic?: string;
      roles?: { aName?: string; aPrompt?: string; bName?: string; bPrompt?: string };
      options?: { openingSpeaker?: "a" | "b"; temporaryChat?: boolean; maxTurns?: number; summaryPrompt?: string };
    }>(request);
    if (!body.topic?.trim()) {
      sendJson(response, 400, { error: "Missing topic." });
      return;
    }
    sendJson(response, 200, await chat.start(body.topic.trim(), body.roles, body.options));
    return;
  }

  if (pathname === "/api/user-message") {
    const body = await readJson<{ text?: string }>(request);
    if (!body.text?.trim()) {
      sendJson(response, 400, { error: "Missing text." });
      return;
    }
    sendJson(response, 200, await chat.addUserMessage(body.text.trim()));
    return;
  }

  if (pathname === "/api/step") {
    sendJson(response, 200, await chat.step());
    return;
  }

  if (pathname === "/api/auto") {
    const body = await readJson<{ turns?: number }>(request);
    const turns = Math.max(1, Math.min(body.turns ?? 4, 20));
    let state = chat.snapshot();
    for (let index = 0; index < turns; index += 1) {
      state = await chat.step();
      if (state.ended) {
        break;
      }
    }
    sendJson(response, 200, state);
    return;
  }

  if (pathname === "/api/run-to-summary") {
    const body = await readJson<{
      topic?: string;
      roles?: { aName?: string; aPrompt?: string; bName?: string; bPrompt?: string };
      options?: { openingSpeaker?: "a" | "b"; temporaryChat?: boolean; maxTurns?: number; summaryPrompt?: string };
    }>(request);
    let state = chat.snapshot();
    if (!state.topic || state.ended) {
      if (!body.topic?.trim()) {
        sendJson(response, 400, { error: "Missing topic." });
        return;
      }
      state = await chat.start(body.topic.trim(), body.roles, body.options);
    }
    const maxTurns = Math.max(1, Math.min(body.options?.maxTurns ?? state.options.maxTurns, 30));
    while (!state.ended && countDiscussionTurns(state) < maxTurns) {
      state = await chat.step();
    }
    if (!state.ended) {
      state = await chat.endAndSummarize();
    }
    sendJson(response, 200, state);
    return;
  }

  if (pathname === "/api/end") {
    sendJson(response, 200, await chat.endAndSummarize());
    return;
  }

  if (pathname === "/api/reset") {
    sendJson(response, 200, await chat.reset());
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function countDiscussionTurns(state: ReturnType<SerialGroupChat["snapshot"]>): number {
  return state.messages.filter((message) => message.kind === "reply" && (message.speaker === "a" || message.speaker === "b")).length;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (safePath.includes("..")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  const filePath = join(process.cwd(), "public", safePath);
  const content = await readFile(filePath);
  response.writeHead(200, { "content-type": contentType(filePath) });
  response.end(content);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
