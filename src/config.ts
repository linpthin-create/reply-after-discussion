import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { DebateConfig } from "./types.js";

const selectorSchema = z.object({
  promptBox: z.array(z.string()).optional(),
  submitButton: z.array(z.string()).optional(),
  answerBlocks: z.array(z.string()).optional(),
  answerMarkdown: z.array(z.string()).optional(),
  stopButton: z.array(z.string()).optional(),
  newChatButton: z.array(z.string()).optional()
});

const modelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  url: z.string().url(),
  browserProfileDir: z.string().min(1).optional(),
  connectOverCDP: z.string().url().optional(),
  browserChannel: z.string().optional(),
  executablePath: z.string().optional(),
  selectors: selectorSchema.optional(),
  waitForIdleMs: z.number().int().positive().optional(),
  minStableMs: z.number().int().positive().optional(),
  extraSettleMs: z.number().int().min(0).optional(),
  responseTimeoutMs: z.number().int().positive().optional(),
  headless: z.boolean().optional()
}).refine((model) => model.browserProfileDir || model.connectOverCDP, {
  message: "Either browserProfileDir or connectOverCDP is required."
});

const configSchema = z.object({
  models: z.object({
    a: modelSchema,
    b: modelSchema,
    judge: modelSchema.optional()
  }),
  rounds: z.number().int().min(1).max(20).default(2),
  outputDir: z.string().min(1).default("runs"),
  browser: z.object({
    slowMoMs: z.number().int().min(0).optional()
  }).optional()
});

export async function loadConfig(path: string): Promise<DebateConfig> {
  const raw = await readFile(path, "utf8");
  return configSchema.parse(JSON.parse(raw));
}
