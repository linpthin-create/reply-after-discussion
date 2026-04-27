import type { GroupMessage } from "./types.js";

export function openingPrompt(topic: string, prefixPrompt: string): string {
  const prefix = prefixPrompt.trim();
  return [
    ...(prefix ? [prefix, ""] : []),
    "讨论议题：",
    topic
  ].join("\n");
}

export function turnPrompt(messages: GroupMessage[]): string {
  return renderIncoming(messages);
}

export function firstTurnPrompt(messages: GroupMessage[], prefixPrompt: string): string {
  const prefix = prefixPrompt.trim();
  return [
    ...(prefix ? [prefix, ""] : []),
    renderIncoming(messages)
  ].join("\n");
}

export const DEFAULT_SUMMARY_PROMPT = [
    "请结束本轮讨论，并直接回应原始议题。",
    "总结应围绕议题本身，而不是复述讨论过程。",
    "请给出：最终答案、关键依据、讨论后修正过的认识、仍不确定的点、后续最值得验证的方向。",
    "",
    "原始议题：",
    "{topic}"
  ].join("\n");

export function summaryPrompt(topic: string, template: string): string {
  const source = template.trim() || DEFAULT_SUMMARY_PROMPT;
  return source.includes("{topic}")
    ? source.replaceAll("{topic}", topic)
    : `${source}\n\n原始议题：\n${topic}`;
}

function renderIncoming(messages: GroupMessage[]): string {
  if (messages.length === 0) {
    return "没有新增消息。请基于当前会话历史给出回应。";
  }
  return messages.map((message) => {
    return `[${message.label}] ${message.text}`;
  }).join("\n\n");
}
