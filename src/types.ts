export type DebateRole = "initial" | "critique" | "revision" | "evaluation" | "judge";
export type GroupSpeaker = "user" | "a" | "b" | "system";
export type GroupMessageKind = "topic" | "opinion" | "reply" | "summary" | "system";

export interface DebateMessage {
  role: DebateRole;
  model: string;
  round: number;
  prompt: string;
  answer: string;
  startedAt: string;
  completedAt: string;
}

export interface DebateResult {
  question: string;
  transcript: DebateMessage[];
  verdict?: DebateMessage;
}

export interface SelectorConfig {
  promptBox?: string[];
  submitButton?: string[];
  answerBlocks?: string[];
  answerMarkdown?: string[];
  stopButton?: string[];
  newChatButton?: string[];
}

export interface ModelConfig {
  id: string;
  label?: string;
  url: string;
  browserProfileDir?: string;
  connectOverCDP?: string;
  browserChannel?: string;
  executablePath?: string;
  selectors?: SelectorConfig;
  waitForIdleMs?: number;
  minStableMs?: number;
  extraSettleMs?: number;
  responseTimeoutMs?: number;
  headless?: boolean;
}

export interface DebateConfig {
  models: {
    a: ModelConfig;
    b: ModelConfig;
    judge?: ModelConfig;
  };
  rounds: number;
  outputDir: string;
  browser?: {
    slowMoMs?: number;
  };
}

export interface WebModelSession {
  id: string;
  open(): Promise<void>;
  newConversation(): Promise<void>;
  ask(prompt: string): Promise<ModelAnswer>;
  close(): Promise<void>;
}

export interface ModelAnswer {
  text: string;
  html?: string;
  source?: "network" | "state" | "dom" | "text";
}

export interface GroupMessage {
  id: number;
  speaker: GroupSpeaker;
  label: string;
  kind: GroupMessageKind;
  text: string;
  html?: string;
  source?: "network" | "state" | "dom" | "text";
  createdAt: string;
}

export interface DiscussionRoles {
  aName: string;
  aPrompt: string;
  bName: string;
  bPrompt: string;
}

export interface GroupChatOptions {
  openingSpeaker: "a" | "b";
  temporaryChat: boolean;
  maxTurns: number;
  summaryPrompt: string;
}

export interface ModelRuntimeInfo {
  id: string;
  label: string;
  url: string;
  connection: "cdp" | "managed";
  endpoint?: string;
}

export interface GroupChatState {
  discussionId?: string;
  topic?: string;
  roles: DiscussionRoles;
  options: GroupChatOptions;
  models: {
    a: ModelRuntimeInfo;
    b: ModelRuntimeInfo;
  };
  messages: GroupMessage[];
  nextSpeaker: "a" | "b";
  running: boolean;
  ended: boolean;
  error?: string;
}
