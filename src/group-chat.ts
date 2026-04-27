import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DebateConfig, GroupChatState, GroupMessage, WebModelSession } from "./types.js";
import { DEFAULT_SUMMARY_PROMPT, firstTurnPrompt, openingPrompt, summaryPrompt, turnPrompt } from "./group-prompts.js";

interface GroupSessions {
  a: WebModelSession;
  b: WebModelSession;
}

const DEFAULT_A_NAME = "研究员";
const DEFAULT_A_PROMPT = "你是该议题相关领域的资深研究员。请直接发表符合身份的思考：给出核心判断、关键理由、必要假设和可推进的问题。不要自称 AI，不要描述系统规则。";
const DEFAULT_B_NAME = "评审专家";
const DEFAULT_B_PROMPT = "你是该议题相关领域的严格评审专家。请客观评判已有思考，查漏补缺，评估风险，纠正错误，并提出进一步思考。不要自称 AI，不要描述系统规则。";

export class SerialGroupChat {
  private state: GroupChatState;
  private seenBy: Record<"a" | "b", number> = { a: 0, b: 0 };
  private roleIntroduced: Record<"a" | "b", boolean> = { a: false, b: false };
  private nextId = 1;

  constructor(private readonly config: DebateConfig, private readonly sessions: GroupSessions) {
    this.state = {
      roles: {
        aName: DEFAULT_A_NAME,
        aPrompt: DEFAULT_A_PROMPT,
        bName: DEFAULT_B_NAME,
        bPrompt: DEFAULT_B_PROMPT
      },
      options: {
        openingSpeaker: "a",
        temporaryChat: false,
        maxTurns: 6,
        summaryPrompt: DEFAULT_SUMMARY_PROMPT
      },
      models: {
        a: this.modelInfo("a"),
        b: this.modelInfo("b")
      },
      messages: [],
      nextSpeaker: "a",
      running: false,
      ended: false
    };
  }

  snapshot(): GroupChatState {
    return structuredClone(this.state);
  }

  async open(): Promise<void> {
    await this.sessions.a.open();
    await this.sessions.b.open();
  }

  async close(): Promise<void> {
    await this.sessions.a.close();
    await this.sessions.b.close();
  }

  async start(
    topic: string,
    roles?: Partial<GroupChatState["roles"]>,
    options?: Partial<GroupChatState["options"]>
  ): Promise<GroupChatState> {
    await this.runExclusive(async () => {
      await this.open();
      const nextOptions = {
        openingSpeaker: options?.openingSpeaker ?? "a",
        temporaryChat: options?.temporaryChat ?? false,
        maxTurns: normalizeMaxTurns(options?.maxTurns),
        summaryPrompt: options?.summaryPrompt?.trim() || DEFAULT_SUMMARY_PROMPT
      };
      if (nextOptions.temporaryChat) {
        await this.sessions.a.newConversation();
        await this.sessions.b.newConversation();
      }
      const nextRoles = {
        aName: roles?.aName?.trim() || DEFAULT_A_NAME,
        aPrompt: roleFieldOrDefault(roles, "aPrompt", DEFAULT_A_PROMPT),
        bName: roles?.bName?.trim() || DEFAULT_B_NAME,
        bPrompt: roleFieldOrDefault(roles, "bPrompt", DEFAULT_B_PROMPT)
      };
      this.state = {
        discussionId: createDiscussionId(),
        topic,
        roles: nextRoles,
        options: nextOptions,
        models: {
          a: this.modelInfo("a"),
          b: this.modelInfo("b")
        },
        messages: [],
        nextSpeaker: nextOptions.openingSpeaker,
        running: true,
        ended: false
      };
      this.seenBy = { a: 0, b: 0 };
      this.roleIntroduced = { a: false, b: false };
      this.nextId = 1;
      this.append("user", "用户", "topic", topic);
      await this.persist();

      const speaker = nextOptions.openingSpeaker;
      const other = speaker === "a" ? "b" : "a";
      const answer = await this.sessions[speaker].ask(openingPrompt(topic, this.rolePrompt(speaker)));
      this.seenBy[speaker] = this.nextId - 1;
      this.roleIntroduced[speaker] = true;
      this.append(speaker, this.label(speaker), "reply", answer.text, answer.html, answer.source);
      this.state.nextSpeaker = other;
      await this.persist();
    });
    return this.snapshot();
  }

  async addUserMessage(text: string): Promise<GroupChatState> {
    if (!this.state.topic || this.state.ended) {
      throw new Error("No active discussion.");
    }
    if (this.state.running) {
      throw new Error("Another discussion action is already running.");
    }
    this.append("user", "用户", "opinion", text);
    await this.persist();
    return this.snapshot();
  }

  async step(): Promise<GroupChatState> {
    if (!this.state.topic || this.state.ended) {
      throw new Error("No active discussion.");
    }
    await this.runExclusive(async () => {
      const speaker = this.state.nextSpeaker;
      const other = speaker === "a" ? "b" : "a";
      const incoming = this.unseenFor(speaker);
      const prompt = this.roleIntroduced[speaker]
        ? turnPrompt(incoming)
        : firstTurnPrompt(incoming, this.rolePrompt(speaker));
      const answer = await this.sessions[speaker].ask(prompt);
      this.seenBy[speaker] = this.nextId - 1;
      this.roleIntroduced[speaker] = true;
      this.append(speaker, this.label(speaker), "reply", answer.text, answer.html, answer.source);
      this.state.nextSpeaker = other;
      await this.persist();
    });
    return this.snapshot();
  }

  async endAndSummarize(): Promise<GroupChatState> {
    if (!this.state.topic || this.state.ended) {
      throw new Error("No active discussion.");
    }
    const topic = this.state.topic;
    await this.runExclusive(async () => {
      const speaker = this.state.options.openingSpeaker;
      const summary = await this.sessions[speaker].ask(summaryPrompt(topic, this.state.options.summaryPrompt));
      this.seenBy[speaker] = this.nextId - 1;
      this.append(speaker, this.label(speaker), "summary", summary.text, summary.html, summary.source);

      this.state.ended = true;
      await this.persist();
    });
    return this.snapshot();
  }

  async reset(): Promise<GroupChatState> {
    if (this.state.running) {
      throw new Error("Another discussion action is already running.");
    }
    this.state = {
      roles: this.state.roles,
      options: this.state.options,
      models: {
        a: this.modelInfo("a"),
        b: this.modelInfo("b")
      },
      messages: [],
      nextSpeaker: this.state.options.openingSpeaker,
      running: false,
      ended: false
    };
    this.seenBy = { a: 0, b: 0 };
    this.roleIntroduced = { a: false, b: false };
    this.nextId = 1;
    await this.persist();
    return this.snapshot();
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.state.running) {
      throw new Error("Another discussion action is already running.");
    }
    this.state.running = true;
    this.state.error = undefined;
    try {
      return await task();
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.state.running = false;
      await this.persist().catch(() => undefined);
    }
  }

  private append(
    speaker: GroupMessage["speaker"],
    label: string,
    kind: GroupMessage["kind"],
    text: string,
    html?: string,
    source?: GroupMessage["source"]
  ): GroupMessage {
    const message: GroupMessage = {
      id: this.nextId,
      speaker,
      label,
      kind,
      text,
      html,
      source,
      createdAt: new Date().toISOString()
    };
    this.nextId += 1;
    this.state.messages.push(message);
    return message;
  }

  private unseenFor(speaker: "a" | "b"): GroupMessage[] {
    return this.state.messages.filter((message) => message.id > this.seenBy[speaker] && message.speaker !== speaker);
  }

  private label(speaker: "a" | "b"): string {
    return speaker === "a" ? this.state.roles.aName : this.state.roles.bName;
  }

  private rolePrompt(speaker: "a" | "b"): string {
    return speaker === "a" ? this.state.roles.aPrompt : this.state.roles.bPrompt;
  }

  private modelInfo(speaker: "a" | "b"): GroupChatState["models"]["a"] {
    const model = speaker === "a" ? this.config.models.a : this.config.models.b;
    return {
      id: model.id,
      label: model.label ?? model.id,
      url: model.url,
      connection: model.connectOverCDP ? "cdp" : "managed",
      endpoint: model.connectOverCDP
    };
  }

  private async persist(): Promise<void> {
    await mkdir(this.config.outputDir, { recursive: true });
    if (this.state.discussionId) {
      const discussionDir = join(this.config.outputDir, "discussions", this.state.discussionId);
      await mkdir(discussionDir, { recursive: true });
      await writeFile(join(discussionDir, "group-chat.json"), JSON.stringify(this.state, null, 2), "utf8");
      await writeFile(join(discussionDir, "group-chat.md"), renderMarkdown(this.state), "utf8");
    }
    await writeFile(join(this.config.outputDir, "group-chat-latest.json"), JSON.stringify(this.state, null, 2), "utf8");
    await writeFile(join(this.config.outputDir, "group-chat-latest.md"), renderMarkdown(this.state), "utf8");
  }
}

function normalizeMaxTurns(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return 6;
  }
  return Math.max(1, Math.min(value, 30));
}

function roleFieldOrDefault(
  roles: Partial<GroupChatState["roles"]> | undefined,
  key: "aPrompt" | "bPrompt",
  fallback: string
): string {
  if (!roles || !(key in roles)) {
    return fallback;
  }
  return roles[key]?.trim() ?? "";
}

function createDiscussionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function renderMarkdown(state: GroupChatState): string {
  return [
    "# Serial Group Chat",
    "",
    "## Topic",
    "",
    state.topic ?? "",
    "",
    "## Roles",
    "",
    `- ${state.roles.aName}: ${state.roles.aPrompt}`,
    `- ${state.roles.bName}: ${state.roles.bPrompt}`,
    "",
    "## Messages",
    "",
    ...state.messages.map((message) => [
      `### ${message.label} (${message.kind})`,
      "",
      message.text
    ].join("\n"))
  ].join("\n");
}
