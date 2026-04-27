import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { ModelAnswer, ModelConfig, SelectorConfig, WebModelSession } from "./types.js";

const defaultSelectors: Required<SelectorConfig> = {
  promptBox: [
    "textarea",
    "[contenteditable='true']",
    "[role='textbox']"
  ],
  submitButton: [
    "button[aria-label*='Send' i]",
    "button[aria-label*='Submit' i]",
    "button[type='submit']"
  ],
  answerBlocks: [
    "[data-message-author-role='assistant']",
    "[data-testid*='conversation-turn']",
    "article",
    ".markdown",
    "[class*='markdown']"
  ],
  answerMarkdown: [
    "[data-message-author-role='assistant'] .markdown",
    "[data-message-author-role='assistant'] [class*='markdown']",
    ".markdown",
    "[class*='markdown']"
  ],
  stopButton: [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop' i]",
    "button[aria-label*='Stop generating' i]",
    "button[aria-label*='停止' i]",
    "button:has-text('Stop')",
    "button:has-text('Stop generating')",
    "button:has-text('停止')",
    "button:has-text('停止生成')",
    "button:has-text('Continue generating')",
    "button:has-text('继续生成')"
  ],
  newChatButton: [
    "a:has-text('New chat')",
    "button:has-text('New chat')",
    "a:has-text('新聊天')",
    "button:has-text('新聊天')"
  ]
};

export class PlaywrightWebModelSession implements WebModelSession {
  public readonly id: string;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private networkCaptureAttached = false;
  private networkCaptureStartedAt = 0;
  private networkCandidates: string[] = [];
  private readonly selectors: Required<SelectorConfig>;
  private readonly waitForIdleMs: number;
  private readonly minStableMs: number;
  private readonly extraSettleMs: number;
  private readonly responseTimeoutMs: number;

  constructor(private readonly config: ModelConfig, private readonly slowMoMs = 0) {
    this.id = config.label ?? config.id;
    this.selectors = mergeSelectors(config.selectors);
    this.waitForIdleMs = config.waitForIdleMs ?? 6000;
    this.minStableMs = config.minStableMs ?? this.waitForIdleMs;
    this.extraSettleMs = config.extraSettleMs ?? 1500;
    this.responseTimeoutMs = config.responseTimeoutMs ?? 180000;
  }

  async open(): Promise<void> {
    if (this.page) {
      return;
    }

    if (this.config.connectOverCDP) {
      this.browser = await chromium.connectOverCDP(this.config.connectOverCDP);
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.page = this.findExistingProviderPage() ?? await this.context.newPage();
      if (!sameOriginOrBlank(this.page.url(), this.config.url)) {
        await this.page.goto(this.config.url, { waitUntil: "domcontentloaded" });
      }
      this.attachNetworkCapture(this.page);
      return;
    }

    if (!this.config.browserProfileDir) {
      throw new Error(`${this.id}: browserProfileDir is required when connectOverCDP is not configured.`);
    }

    this.context = await chromium.launchPersistentContext(this.config.browserProfileDir, {
      channel: this.config.browserChannel,
      executablePath: this.config.executablePath,
      headless: this.config.headless ?? false,
      slowMo: this.slowMoMs
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    this.attachNetworkCapture(this.page);
  }

  async newConversation(): Promise<void> {
    const page = this.requirePage();
    const newChat = await firstVisible(page, this.selectors.newChatButton, 1500);
    if (newChat) {
      await newChat.click();
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }

  async ask(prompt: string): Promise<ModelAnswer> {
    const page = this.requirePage();
    const before = await this.latestAnswerText();
    const beforeCounts = await this.answerBlockCounts();
    this.startNetworkCapture();
    const box = await firstVisible(page, this.selectors.promptBox, 30000);
    if (!box) {
      throw new Error(`${this.id}: cannot find prompt input. Update selectors.promptBox in config.`);
    }

    await fillPrompt(box, prompt);
    const submit = await firstVisible(page, this.selectors.submitButton, 5000);
    if (submit) {
      await submit.click();
    } else {
      await box.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter").catch(async () => {
        await box.press("Enter");
      });
    }

    await this.waitForResponseChange(before, beforeCounts);
    const settled = await this.waitUntilGenerationSettles();
    const answer = await this.readFinalAnswer(beforeCounts, settled);
    if (!answer.text || answer.text === before) {
      throw new Error(`${this.id}: response did not change or could not be read. Update selectors.answerBlocks in config.`);
    }
    return answer;
  }

  async close(): Promise<void> {
    if (this.config.connectOverCDP) {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      return;
    }
    await this.context?.close();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  private findExistingProviderPage(): Page | undefined {
    if (!this.context) {
      return undefined;
    }
    return this.context.pages().find((page) => sameOriginOrBlank(page.url(), this.config.url));
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error(`${this.id}: session is not open.`);
    }
    return this.page;
  }

  private async latestAnswerText(): Promise<string> {
    const page = this.requirePage();
    const markdown = await this.latestAnswerMarkdown();
    if (markdown) {
      return markdown;
    }
    for (const selector of this.selectors.answerBlocks) {
      const blocks = page.locator(selector);
      const count = await blocks.count().catch(() => 0);
      if (count > 0) {
        const block = blocks.nth(count - 1);
        const text = await block.innerText({ timeout: 1000 }).catch(() => "");
        if (text.trim()) {
          return normalizeText(text);
        }
      }
    }
    return "";
  }

  private async latestAnswerTextAfter(previousCounts: Map<string, number>): Promise<ModelAnswer> {
    const page = this.requirePage();
    for (const selector of this.selectors.answerBlocks) {
      const blocks = page.locator(selector);
      const count = await blocks.count().catch(() => 0);
      const previousCount = previousCounts.get(selector) ?? 0;
      if (count > previousCount) {
        const block = blocks.nth(count - 1);
        const answer = await extractAnswerFromLocator(block);
        if (answer.text) {
          return answer;
        }
        const text = await block.innerText({ timeout: 1000 }).catch(() => "");
        if (text.trim()) {
          return { text: normalizeText(text), source: "text" };
        }
      }
    }
    return { text: "" };
  }

  private async answerBlockCounts(): Promise<Map<string, number>> {
    const page = this.requirePage();
    const counts = new Map<string, number>();
    for (const selector of this.selectors.answerBlocks) {
      counts.set(selector, await page.locator(selector).count().catch(() => 0));
    }
    return counts;
  }

  private async latestAnswerMarkdown(): Promise<string> {
    const page = this.requirePage();
    for (const selector of this.selectors.answerMarkdown) {
      const blocks = page.locator(selector);
      const count = await blocks.count().catch(() => 0);
      if (count > 0) {
        const answer = await extractAnswerFromLocator(blocks.nth(count - 1));
        if (answer.text) {
          return answer.text;
        }
      }
    }
    return "";
  }

  private async waitForResponseChange(previous: string, previousCounts: Map<string, number>): Promise<void> {
    const deadline = Date.now() + this.responseTimeoutMs;
    while (Date.now() < deadline) {
      const newAnswer = await this.latestAnswerTextAfter(previousCounts);
      if (newAnswer.text) {
        return;
      }
      const current = await this.latestAnswerText();
      if (current && current !== previous) {
        return;
      }
      await this.requirePage().waitForTimeout(1000);
    }
    throw new Error(`${this.id}: timed out waiting for response.`);
  }

  private async readFinalAnswer(previousCounts: Map<string, number>, settled: boolean): Promise<ModelAnswer> {
    const answer = await this.latestAnswerTextAfter(previousCounts);
    if (answer.text) {
      await this.requirePage().waitForTimeout(500);
      const captured = this.bestNetworkAnswer(answer.text);
      if (captured) {
        return captured;
      }
      return answer;
    }
    const text = await this.latestAnswerText();
    if (text || settled) {
      await this.requirePage().waitForTimeout(500);
      const captured = this.bestNetworkAnswer(text);
      if (captured) {
        return captured;
      }
      return { text, source: "text" };
    }
    return { text: "" };
  }

  private attachNetworkCapture(page: Page): void {
    if (this.networkCaptureAttached) {
      return;
    }
    this.networkCaptureAttached = true;
    page.on("response", (response) => {
      void this.captureResponse(response.url(), response.headers(), () => response.text());
    });
  }

  private startNetworkCapture(): void {
    this.networkCaptureStartedAt = Date.now();
    this.networkCandidates = [];
  }

  private async captureResponse(
    url: string,
    headers: Record<string, string>,
    readText: () => Promise<string>
  ): Promise<void> {
    if (!this.networkCaptureStartedAt) {
      return;
    }
    if (Date.now() - this.networkCaptureStartedAt > this.responseTimeoutMs + 60000) {
      return;
    }
    if (!looksLikeAnswerResponse(url, headers)) {
      return;
    }

    const contentLength = Number(headers["content-length"] ?? 0);
    if (contentLength > 8_000_000) {
      return;
    }

    const body = await readText().catch(() => "");
    if (!body || body.length > 8_000_000) {
      return;
    }

    for (const candidate of extractNetworkCandidates(body)) {
      this.addNetworkCandidate(candidate);
    }
  }

  private addNetworkCandidate(candidate: string): void {
    const normalized = normalizeMarkdown(candidate);
    if (normalized.length < 20 || normalized.length > 200000) {
      return;
    }
    if (this.networkCandidates.includes(normalized)) {
      return;
    }
    this.networkCandidates.push(normalized);
    if (this.networkCandidates.length > 300) {
      this.networkCandidates.splice(0, this.networkCandidates.length - 300);
    }
  }

  private bestNetworkAnswer(visibleAnswer: string): ModelAnswer | undefined {
    if (!visibleAnswer.trim() || this.networkCandidates.length === 0) {
      return undefined;
    }

    const visible = normalizeForCompare(stripMarkdown(visibleAnswer));
    let best: { text: string; score: number } | undefined;
    for (const candidate of this.networkCandidates) {
      const score = scoreRawCandidate(candidate, visible, "network");
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { text: candidate, score };
      }
    }

    if (!best || best.score < 560) {
      return undefined;
    }
    return {
      text: best.text,
      source: "network"
    };
  }

  private async waitUntilGenerationSettles(): Promise<boolean> {
    const page = this.requirePage();
    let stableSince = Date.now();
    let previous = await this.latestAnswerText();
    const deadline = Date.now() + this.responseTimeoutMs;

    while (Date.now() < deadline) {
      const stop = await firstVisible(page, this.selectors.stopButton, 500);
      const inputReady = await this.isPromptInputReady();
      const current = await this.latestAnswerText();
      if (current !== previous || stop) {
        previous = current;
        stableSince = Date.now();
      }
      if (!stop && inputReady && Date.now() - stableSince >= this.minStableMs) {
        if (this.extraSettleMs > 0) {
          await page.waitForTimeout(this.extraSettleMs);
          const afterExtraWait = await this.latestAnswerText();
          if (afterExtraWait !== previous) {
            previous = afterExtraWait;
            stableSince = Date.now();
            continue;
          }
        }
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async isPromptInputReady(): Promise<boolean> {
    const page = this.requirePage();
    for (const selector of this.selectors.promptBox) {
      const locator = page.locator(selector).last();
      const visible = await locator.isVisible({ timeout: 300 }).catch(() => false);
      if (!visible) {
        continue;
      }
      const disabled = await locator.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          return element.disabled || element.readOnly;
        }
        return element.getAttribute("aria-disabled") === "true";
      }).catch(() => false);
      if (!disabled) {
        return true;
      }
    }
    return false;
  }
}

function mergeSelectors(selectors?: SelectorConfig): Required<SelectorConfig> {
  return {
    promptBox: selectors?.promptBox ?? defaultSelectors.promptBox,
    submitButton: selectors?.submitButton ?? defaultSelectors.submitButton,
    answerBlocks: selectors?.answerBlocks ?? defaultSelectors.answerBlocks,
    answerMarkdown: selectors?.answerMarkdown ?? defaultSelectors.answerMarkdown,
    stopButton: selectors?.stopButton ?? defaultSelectors.stopButton,
    newChatButton: selectors?.newChatButton ?? defaultSelectors.newChatButton
  };
}

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).last();
      const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        return locator;
      }
    }
  }
  return undefined;
}

async function fillPrompt(locator: Locator, prompt: string): Promise<void> {
  await locator.click();
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
  if (tagName === "textarea" || tagName === "input") {
    await locator.fill(prompt);
    return;
  }
  await locator.evaluate((element, text) => {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }, prompt);
}

async function extractAnswerFromLocator(locator: Locator): Promise<ModelAnswer> {
  const extracted = await locator.evaluate((root) => {
    const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE"]);
    const stateMarkdown = findStateMarkdown(root);
    const clone = root.cloneNode(true) as Element;
    sanitizeForDisplay(clone);

    function renderNode(node: Node): string {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? "";
      }
      if (!(node instanceof Element)) {
        return "";
      }

      const math = extractMath(node);
      if (math) {
        return math;
      }

      const tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "BUTTON" || tag === "SVG") {
        return "";
      }
      if (tag === "BR") {
        return "\n";
      }
      if (tag === "PRE") {
        const code = node.textContent ?? "";
        return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
      }
      if (tag === "CODE") {
        return `\`${node.textContent ?? ""}\``;
      }
      if (tag === "STRONG" || tag === "B") {
        return `**${renderChildren(node).trim()}**`;
      }
      if (tag === "EM" || tag === "I") {
        return `*${renderChildren(node).trim()}*`;
      }
      if (tag === "LI") {
        return `- ${renderChildren(node).trim()}\n`;
      }
      if (tag === "UL" || tag === "OL") {
        return `\n${renderChildren(node).trim()}\n`;
      }
      if (tag === "TABLE") {
        return renderTable(node as HTMLTableElement);
      }
      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        return `\n${"#".repeat(level)} ${renderChildren(node).trim()}\n`;
      }

      const content = renderChildren(node);
      if (blockTags.has(tag)) {
        return `\n${content.trim()}\n`;
      }
      return content;
    }

    function renderChildren(element: Element): string {
      return Array.from(element.childNodes).map(renderNode).join("");
    }

    function extractMath(element: Element): string {
      const isMathRoot = element.classList.contains("katex")
        || element.classList.contains("katex-display")
        || element.tagName.toLowerCase() === "mjx-container";
      if (!isMathRoot) {
        return "";
      }
      const tex = element.querySelector?.("annotation[encoding='application/x-tex']");
      if (tex?.textContent?.trim()) {
        const display = element.closest(".katex-display, mjx-container[display='true']");
        const body = tex.textContent.trim();
        return display ? `\n\n$$\n${body}\n$$\n\n` : `$${body}$`;
      }
      const aria = element.getAttribute("aria-label");
      if ((element.classList.contains("katex") || element.tagName.toLowerCase() === "mjx-container") && aria?.trim()) {
        const display = element.closest(".katex-display, mjx-container[display='true']");
        return display ? `\n\n$$\n${aria.trim()}\n$$\n\n` : `$${aria.trim()}$`;
      }
      return "";
    }

    function sanitizeForDisplay(element: Element): void {
      element.querySelectorAll("script, style, button").forEach((node) => node.remove());
      element.querySelectorAll(".katex").forEach((node) => {
        const tex = node.querySelector("annotation[encoding='application/x-tex']")?.textContent?.trim();
        if (!tex) {
          return;
        }
        const wrapper = document.createElement(node.closest(".katex-display") ? "div" : "span");
        wrapper.className = node.closest(".katex-display") ? "math-block" : "math-inline";
        wrapper.textContent = node.closest(".katex-display") ? `$$${tex}$$` : `$${tex}$`;
        const display = node.closest(".katex-display");
        if (display) {
          display.replaceWith(wrapper);
        } else {
          node.replaceWith(wrapper);
        }
      });
      element.querySelectorAll("mjx-container").forEach((node) => {
        const tex = node.getAttribute("aria-label")?.trim();
        if (!tex) {
          return;
        }
        const wrapper = document.createElement(node.getAttribute("display") === "true" ? "div" : "span");
        wrapper.className = node.getAttribute("display") === "true" ? "math-block" : "math-inline";
        wrapper.textContent = node.getAttribute("display") === "true" ? `$$${tex}$$` : `$${tex}$`;
        node.replaceWith(wrapper);
      });
    }

    function renderTable(table: HTMLTableElement): string {
      const rows = Array.from(table.querySelectorAll("tr")).map((row) => {
        return Array.from(row.children).map((cell) => renderChildren(cell).trim().replace(/\|/g, "\\|"));
      }).filter((row) => row.length > 0);
      if (rows.length === 0) {
        return "";
      }
      const width = Math.max(...rows.map((row) => row.length));
      const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
      const header = normalized[0];
      const separator = Array(width).fill("---");
      const body = normalized.slice(1);
      return [
        "",
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
        ""
      ].join("\n");
    }

    function findStateMarkdown(element: Element): string {
      const visibleText = normalizeForCompare(element.textContent ?? "");
      if (visibleText.length < 30) {
        return "";
      }

      const seeds = collectStateSeeds(element);
      const seen = new WeakSet<object>();
      const candidates: Array<{ text: string; score: number }> = [];
      const stack = seeds.map((value) => ({ value, depth: 0, keyHint: "" }));
      let inspected = 0;

      while (stack.length > 0 && inspected < 8000) {
        const item = stack.pop();
        if (!item) {
          break;
        }
        inspected += 1;

        const value = item.value;
        if (typeof value === "string") {
          const score = scoreStateString(value, item.keyHint, visibleText);
          if (score > 0) {
            candidates.push({ text: value, score });
          }
          continue;
        }
        if (!value || typeof value !== "object" || item.depth > 7) {
          continue;
        }
        if (value instanceof Node || value === window || value === document) {
          continue;
        }
        if (seen.has(value)) {
          continue;
        }
        seen.add(value);

        if (Array.isArray(value)) {
          const joined = joinStringArray(value);
          const score = joined ? scoreStateString(joined, item.keyHint, visibleText) : 0;
          if (score > 0) {
            candidates.push({ text: joined, score: score + 20 });
          }
        }

        for (const key of Object.keys(value).slice(0, 120)) {
          if (key === "stateNode" || key === "return" || key === "child" || key === "sibling" || key === "alternate") {
            continue;
          }
          const child = (value as Record<string, unknown>)[key];
          if (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
            continue;
          }
          stack.push({
            value: child,
            depth: item.depth + 1,
            keyHint: key
          });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.text.trim() ?? "";
    }

    function collectStateSeeds(element: Element): unknown[] {
      const seeds: unknown[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 8; depth += 1) {
        for (const key of Object.keys(current)) {
          if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$") || key.startsWith("__reactContainer$")) {
            seeds.push((current as unknown as Record<string, unknown>)[key]);
          }
        }
        current = current.parentElement;
      }
      return seeds;
    }

    function joinStringArray(value: unknown[]): string {
      const parts: string[] = [];
      for (const item of value) {
        if (typeof item === "string") {
          parts.push(item);
          continue;
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.text === "string") {
            parts.push(record.text);
          } else if (typeof record.content === "string") {
            parts.push(record.content);
          }
        }
      }
      const joined = parts.join("");
      return joined.length >= 30 ? joined : "";
    }

    function scoreStateString(value: string, keyHint: string, visibleText: string): number {
      const text = value.trim();
      if (text.length < 30 || text.length > 200000) {
        return 0;
      }
      if (/^\s*https?:\/\//i.test(text) || /^data:image\//i.test(text)) {
        return 0;
      }

      const plain = normalizeForCompare(stripMarkdown(text));
      if (plain.length < Math.min(visibleText.length * 0.25, 80)) {
        return 0;
      }

      const overlap = overlapRatio(plain, visibleText);
      if (overlap < 0.52) {
        return 0;
      }

      let score = overlap * 1000 + Math.min(text.length, 20000) / 100;
      if (hasMarkdownSignals(text)) {
        score += 220;
      }
      if (/(markdown|content|text|message|parts|answer|body)/i.test(keyHint)) {
        score += 80;
      }
      if (/<[a-z][\s\S]*>/i.test(text) && !/[`*_#$\\|]/.test(text)) {
        score -= 120;
      }
      return score;
    }

    function hasMarkdownSignals(text: string): boolean {
      return /```|\*\*|__|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|\$\$|\\\[|\\\(|\|[^\n]+\||!\[[^\]]*]\(/m.test(text);
    }

    function stripMarkdown(text: string): string {
      return text
        .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z0-9_-]*|```/g, ""))
        .replace(/!\[[^\]]*]\([^)]+\)/g, "")
        .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
        .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
        .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
        .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
        .replace(/[*_`~>#-]/g, "")
        .replace(/\|/g, " ");
    }

    function normalizeForCompare(text: string): string {
      return text
        .replace(/\s+/g, "")
        .replace(/[.,，。:：;；!?！？()[\]{}"'“”‘’<>《》、|`*_~#\\$-]/g, "")
        .toLowerCase();
    }

    function overlapRatio(candidate: string, visibleText: string): number {
      const short = candidate.length <= visibleText.length ? candidate : visibleText;
      const long = candidate.length <= visibleText.length ? visibleText : candidate;
      if (long.includes(short.slice(0, Math.min(short.length, 180)))) {
        return Math.min(1, short.length / Math.max(visibleText.length, 1));
      }
      const grams = new Set<string>();
      const gramSize = short.length > 80 ? 4 : 2;
      for (let index = 0; index <= short.length - gramSize; index += gramSize) {
        grams.add(short.slice(index, index + gramSize));
        if (grams.size >= 240) {
          break;
        }
      }
      if (grams.size === 0) {
        return 0;
      }
      let hits = 0;
      for (const gram of grams) {
        if (long.includes(gram)) {
          hits += 1;
        }
      }
      return hits / grams.size;
    }

    return {
      text: stateMarkdown || renderNode(root),
      html: stateMarkdown ? undefined : clone.innerHTML,
      source: stateMarkdown ? "state" : "dom"
    };
  }).catch(() => "");
  if (!extracted || typeof extracted === "string") {
    return { text: "" };
  }
  return {
    text: normalizeMarkdown(extracted.text),
    html: extracted.html?.trim() || undefined,
    source: extracted.source === "state" ? "state" : "dom"
  };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeAnswerResponse(url: string, headers: Record<string, string>): boolean {
  const contentType = headers["content-type"] ?? "";
  const lowerUrl = url.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css|map)(\?|$)/i.test(lowerUrl)) {
    return false;
  }
  if (!/(json|text|event-stream|x-www-form-urlencoded|javascript|octet-stream)/i.test(contentType)
    && !/(conversation|completion|stream|generate|message|batchexecute|assistant|bard|chat)/i.test(lowerUrl)) {
    return false;
  }
  return /(chatgpt|openai|gemini|google|bard|anthropic|claude|perplexity|poe|grok|x\.ai|deepseek|kimi|moonshot|doubao|volcengine|qwen|tongyi|baidu|wenxin|ernie|zhipu|chatglm)/i.test(lowerUrl)
    || /(conversation|completion|stream|generate|message|batchexecute|assistant|bard|chat)/i.test(lowerUrl);
}

function extractNetworkCandidates(body: string): string[] {
  const candidates: string[] = [];
  const fragments: string[] = [];
  const parsedValues = parsePayloadCandidates(body);
  for (const value of parsedValues) {
    collectCandidateStrings(value, "", candidates, fragments, new WeakSet<object>(), 0);
  }

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]" || trimmed === "[DONE]") {
      continue;
    }
    const text = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    const decoded = decodeJsonStringLiteral(text);
    if (decoded && decoded !== text) {
      collectCandidateStrings(decoded, "line", candidates, fragments, new WeakSet<object>(), 0);
    }
  }

  const joined = joinLikelyFragments(fragments);
  if (joined) {
    candidates.push(joined);
  }

  return uniqueStrings(candidates).filter((candidate) => {
    const normalized = normalizeMarkdown(candidate);
    return normalized.length >= 20
      && normalized.length <= 200000
      && !/^\s*(https?:\/\/|data:image\/|[a-f0-9-]{24,})\s*$/i.test(normalized);
  });
}

function parsePayloadCandidates(body: string): unknown[] {
  const values: unknown[] = [];
  const whole = parseLooseJson(body);
  if (whole !== undefined) {
    values.push(whole);
  }

  const withoutXssi = body.replace(/^\)\]\}'\s*/, "").trim();
  if (withoutXssi !== body.trim()) {
    const parsed = parseLooseJson(withoutXssi);
    if (parsed !== undefined) {
      values.push(parsed);
    }
  }

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed === "data: [DONE]") {
      continue;
    }
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    const parsed = parseLooseJson(payload);
    if (parsed !== undefined) {
      values.push(parsed);
    }
  }

  return values;
}

function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const cleaned = trimmed.replace(/^\)\]\}'\s*/, "").trim();
  if (!/^[\[{"]/.test(cleaned)) {
    return undefined;
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function collectCandidateStrings(
  value: unknown,
  keyHint: string,
  candidates: string[],
  fragments: string[],
  seen: WeakSet<object>,
  depth: number
): void {
  if (depth > 10 || value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    const decoded = decodeJsonStringLiteral(value) ?? value;
    const nested = parseLooseJson(decoded);
    if (nested !== undefined && nested !== value) {
      collectCandidateStrings(nested, keyHint, candidates, fragments, seen, depth + 1);
      return;
    }

    const text = normalizeMarkdown(decoded);
    if (!text) {
      return;
    }
    if (scoreFragmentLikelihood(text, keyHint) > 0) {
      fragments.push(text);
    }
    if (text.length >= 20 && (hasMarkdownSignals(text) || /(content|text|markdown|message|answer|body|parts|delta)/i.test(keyHint))) {
      candidates.push(text);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const joined = joinArrayText(value);
    if (joined) {
      candidates.push(joined);
    }
    value.forEach((item, index) => collectCandidateStrings(item, `${keyHint}.${index}`, candidates, fragments, seen, depth + 1));
    return;
  }

  const record = value as Record<string, unknown>;
  const direct = directTextFromRecord(record);
  if (direct) {
    candidates.push(direct);
  }

  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
      continue;
    }
    collectCandidateStrings(child, key, candidates, fragments, seen, depth + 1);
  }
}

function directTextFromRecord(record: Record<string, unknown>): string {
  const keys = ["markdown", "content", "text", "answer", "message", "body", "value"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length >= 20) {
      return value;
    }
  }
  const parts = record.parts ?? record.content;
  if (Array.isArray(parts)) {
    const joined = joinArrayText(parts);
    if (joined) {
      return joined;
    }
  }
  return "";
}

function joinArrayText(value: unknown[]): string {
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && scoreFragmentLikelihood(item, "array") > 0) {
      parts.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const direct = directTextFromRecord(record);
      if (direct && scoreFragmentLikelihood(direct, "array") > 0) {
        parts.push(direct);
      }
    }
  }
  const joined = parts.join("");
  return joined.length >= 20 ? joined : "";
}

function joinLikelyFragments(fragments: string[]): string {
  const useful = fragments.filter((fragment) => scoreFragmentLikelihood(fragment, "joined") > 0);
  if (useful.length === 0) {
    return "";
  }
  const joinedNoSpace = useful.join("");
  const joinedNewline = useful.join("\n");
  return joinedNoSpace.length >= joinedNewline.length * 0.8 ? joinedNoSpace : joinedNewline;
}

function scoreFragmentLikelihood(text: string, keyHint: string): number {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200000) {
    return 0;
  }
  if (/^(https?:\/\/|data:image\/|[a-f0-9-]{16,}|[A-Z_]{2,}|true|false|null|\d+)$/.test(trimmed)) {
    return 0;
  }
  let score = 0;
  if (/[A-Za-z\u4e00-\u9fff]/.test(trimmed)) {
    score += 1;
  }
  if (hasMarkdownSignals(trimmed) || /[。！？.!?]\s*$/.test(trimmed)) {
    score += 1;
  }
  if (/(markdown|content|text|message|answer|body|parts|delta)/i.test(keyHint)) {
    score += 2;
  }
  return score;
}

function decodeJsonStringLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (/\\[nrt"\\/u]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(`"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeMarkdown(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function scoreRawCandidate(candidate: string, visibleText: string, keyHint: string): number {
  const text = normalizeMarkdown(candidate);
  if (text.length < 20 || text.length > 200000 || visibleText.length < 10) {
    return 0;
  }
  const plain = normalizeForCompare(stripMarkdown(text));
  if (plain.length < Math.min(visibleText.length * 0.2, 50)) {
    return 0;
  }

  const overlap = overlapRatio(plain, visibleText);
  if (overlap < 0.5) {
    return 0;
  }

  const relativeLength = plain.length / Math.max(visibleText.length, 1);
  let score = overlap * 1000;
  if (hasMarkdownSignals(text)) {
    score += 260;
  }
  if (/(markdown|content|text|message|answer|body|parts|delta|network)/i.test(keyHint)) {
    score += 80;
  }
  if (relativeLength > 5) {
    score -= Math.min(280, (relativeLength - 5) * 35);
  }
  if (relativeLength < 0.45) {
    score -= 200;
  }
  return score;
}

function hasMarkdownSignals(text: string): boolean {
  return /```|\*\*|__|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|\$\$|\\\[|\\\(|\\begin\{|\|[^\n]+\||!\[[^\]]*]\(/m.test(text);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z0-9_-]*|```/g, ""))
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/[*_`~>#-]/g, "")
    .replace(/\|/g, " ");
}

function normalizeForCompare(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[.,，。:：;；!?！？()[\]{}"'“”‘’<>《》、|`*_~#\\$-]/g, "")
    .toLowerCase();
}

function overlapRatio(candidate: string, visibleText: string): number {
  const short = candidate.length <= visibleText.length ? candidate : visibleText;
  const long = candidate.length <= visibleText.length ? visibleText : candidate;
  if (long.includes(short.slice(0, Math.min(short.length, 180)))) {
    return Math.min(1, short.length / Math.max(visibleText.length, 1));
  }
  const grams = new Set<string>();
  const gramSize = short.length > 80 ? 4 : 2;
  for (let index = 0; index <= short.length - gramSize; index += gramSize) {
    grams.add(short.slice(index, index + gramSize));
    if (grams.size >= 320) {
      break;
    }
  }
  if (grams.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const gram of grams) {
    if (long.includes(gram)) {
      hits += 1;
    }
  }
  return hits / grams.size;
}

function sameOriginOrBlank(currentUrl: string, targetUrl: string): boolean {
  if (!currentUrl || currentUrl === "about:blank") {
    return true;
  }
  try {
    return new URL(currentUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}
