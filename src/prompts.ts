import type { DebateMessage } from "./types.js";

export function initialPrompt(question: string): string {
  return [
    "你是串行辩论中的 Model A。请先独立回答用户问题。",
    "要求：给出明确结论、关键理由、必要假设；如果信息不足，请标注不确定性。",
    "",
    "用户问题：",
    question
  ].join("\n");
}

export function critiquePrompt(question: string, aAnswer: string): string {
  return [
    "你是串行辩论中的 Model B。你的任务不是重新回答，而是严格审查 Model A 的回答。",
    "请指出：事实错误、逻辑漏洞、遗漏的重要条件、可替代解释、需要补充的证据。",
    "如果 A 的回答基本正确，也要说明边界条件和改进点。",
    "",
    "原问题：",
    question,
    "",
    "Model A 的回答：",
    aAnswer
  ].join("\n");
}

export function revisionPrompt(question: string, transcript: DebateMessage[]): string {
  return [
    "你是串行辩论中的 Model A。请根据 Model B 的批评修正你的回答。",
    "要求：保留仍然成立的观点，明确采纳或反驳 B 的批评，并输出一个更强的最终版本。",
    "",
    "原问题：",
    question,
    "",
    "辩论记录：",
    renderTranscript(transcript)
  ].join("\n");
}

export function evaluationPrompt(question: string, transcript: DebateMessage[]): string {
  return [
    "你是串行辩论中的 Model B。请评估 Model A 的修正版。",
    "要求：判断是否解决了上一轮问题，指出仍需修正之处，并给出通过/不通过结论。",
    "",
    "原问题：",
    question,
    "",
    "辩论记录：",
    renderTranscript(transcript)
  ].join("\n");
}

export function judgePrompt(question: string, transcript: DebateMessage[]): string {
  return [
    "你是裁判。请基于完整串行辩论记录给出最终总结。",
    "要求：不要盲从最后一个模型；综合双方最强论点，输出最终答案、依据、争议点和不确定性。",
    "",
    "原问题：",
    question,
    "",
    "完整辩论记录：",
    renderTranscript(transcript)
  ].join("\n");
}

export function renderTranscript(transcript: DebateMessage[]): string {
  return transcript.map((message) => {
    return [
      `## ${message.model} / ${message.role} / round ${message.round}`,
      message.answer
    ].join("\n");
  }).join("\n\n");
}
