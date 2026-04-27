import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DebateConfig, DebateMessage, DebateResult, DebateRole, WebModelSession } from "./types.js";
import { critiquePrompt, evaluationPrompt, initialPrompt, judgePrompt, renderTranscript, revisionPrompt } from "./prompts.js";

export interface DebateSessions {
  a: WebModelSession;
  b: WebModelSession;
  judge?: WebModelSession;
}

export async function runDebate(config: DebateConfig, sessions: DebateSessions, question: string): Promise<DebateResult> {
  await mkdir(config.outputDir, { recursive: true });

  await sessions.a.open();
  await sessions.b.open();
  if (sessions.judge) {
    await sessions.judge.open();
  }

  await sessions.a.newConversation();
  await sessions.b.newConversation();
  if (sessions.judge) {
    await sessions.judge.newConversation();
  }

  const transcript: DebateMessage[] = [];
  const initial = await askAndRecord(sessions.a, "initial", 1, initialPrompt(question));
  transcript.push(initial);
  await persist(config.outputDir, question, transcript);

  for (let round = 1; round <= config.rounds; round += 1) {
    const critique = await askAndRecord(
      sessions.b,
      round === 1 ? "critique" : "evaluation",
      round,
      round === 1 ? critiquePrompt(question, initial.answer) : evaluationPrompt(question, transcript)
    );
    transcript.push(critique);
    await persist(config.outputDir, question, transcript);

    if (round < config.rounds) {
      const revision = await askAndRecord(sessions.a, "revision", round + 1, revisionPrompt(question, transcript));
      transcript.push(revision);
      await persist(config.outputDir, question, transcript);
    }
  }

  const judgeSession = sessions.judge ?? sessions.a;
  const verdict = await askAndRecord(judgeSession, "judge", config.rounds, judgePrompt(question, transcript));
  transcript.push(verdict);
  const result: DebateResult = { question, transcript, verdict };
  await persist(config.outputDir, question, transcript, result);
  return result;
}

async function askAndRecord(session: WebModelSession, role: DebateRole, round: number, prompt: string): Promise<DebateMessage> {
  const startedAt = new Date().toISOString();
  const answer = await session.ask(prompt);
  return {
    role,
    model: session.id,
    round,
    prompt,
    answer: answer.text,
    startedAt,
    completedAt: new Date().toISOString()
  };
}

async function persist(outputDir: string, question: string, transcript: DebateMessage[], result?: DebateResult): Promise<void> {
  const data = result ?? { question, transcript };
  await writeFile(join(outputDir, "latest.json"), JSON.stringify(data, null, 2), "utf8");
  await writeFile(join(outputDir, "latest.md"), renderMarkdown(question, transcript), "utf8");
}

function renderMarkdown(question: string, transcript: DebateMessage[]): string {
  return [
    "# Serial Debate",
    "",
    "## Question",
    "",
    question,
    "",
    "## Transcript",
    "",
    renderTranscript(transcript)
  ].join("\n");
}
