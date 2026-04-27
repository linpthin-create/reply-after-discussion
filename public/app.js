const els = {
  openingSpeaker: document.querySelector("#openingSpeaker"),
  temporaryChat: document.querySelector("#temporaryChat"),
  maxTurns: document.querySelector("#maxTurns"),
  roleASelect: document.querySelector("#roleASelect"),
  roleBSelect: document.querySelector("#roleBSelect"),
  roleAName: document.querySelector("#roleAName"),
  roleBName: document.querySelector("#roleBName"),
  roleAPrompt: document.querySelector("#roleAPrompt"),
  roleBPrompt: document.querySelector("#roleBPrompt"),
  summaryPrompt: document.querySelector("#summaryPrompt"),
  stepBtn: document.querySelector("#stepBtn"),
  autoBtn: document.querySelector("#autoBtn"),
  endBtn: document.querySelector("#endBtn"),
  newDiscussionBtn: document.querySelector("#newDiscussionBtn"),
  runToSummaryBtn: document.querySelector("#runToSummaryBtn"),
  sendUserBtn: document.querySelector("#sendUserBtn"),
  userMessage: document.querySelector("#userMessage"),
  chat: document.querySelector("#chat"),
  runState: document.querySelector("#runState"),
  nextSpeaker: document.querySelector("#nextSpeaker"),
  messageCount: document.querySelector("#messageCount"),
  topicTitle: document.querySelector("#topicTitle"),
  modelAInfo: document.querySelector("#modelAInfo"),
  modelBInfo: document.querySelector("#modelBInfo"),
  error: document.querySelector("#error")
};

let state = null;
let polling = null;
let lastRenderedMessageId = 0;
let renderedDiscussionId = null;
let renderedMessageKeys = [];

const rolePresets = [
  { name: "研究员", prompt: "你是该议题相关领域的资深研究员。请直接发表符合身份的思考：给出核心判断、关键理由、必要假设和可推进的问题。不要自称 AI，不要描述系统规则。" },
  { name: "评审专家", prompt: "你是该议题相关领域的严格评审专家。请客观评判已有思考，查漏补缺，评估风险，纠正错误，并提出进一步思考。不要自称 AI，不要描述系统规则。" },
  { name: "ML 研究员", prompt: "你是机器学习方向的资深研究员。请关注问题定义、方法简洁性、泛化能力、实验设计和可验证假设，直接给出建设性思考。" },
  { name: "ML 审稿人", prompt: "你是机器学习顶会审稿人。请严格审查 novelty、baseline、公平比较、消融实验、统计显著性和结论边界，并提出具体修改意见。" },
  { name: "CV 研究员", prompt: "你是计算机视觉方向的研究员。请关注数据偏差、视觉表征、泛化、鲁棒性和 benchmark 可信度，给出专业判断。" },
  { name: "NLP 专家", prompt: "你是自然语言处理方向的研究专家。请关注语言建模、推理能力、评测泄漏、人类偏好和任务定义，给出专业判断。" },
  { name: "VLM 专家", prompt: "你是多模态大模型与 VLM 研究专家。请关注视觉-语言对齐、grounding、幻觉、跨模态推理和评测设计。" },
  { name: "RL 研究员", prompt: "你是强化学习方向的研究员。请关注 credit assignment、探索、离线评估、奖励设计和真实环境部署风险。" },
  { name: "机器人专家", prompt: "你是机器人与具身智能方向的研究员。请关注 sim2real、闭环控制、数据收集、任务泛化和安全约束。" },
  { name: "系统专家", prompt: "你是 AI 系统与推理加速方向的工程研究员。请关注吞吐、延迟、显存、部署复杂度、稳定性和成本。" },
  { name: "安全审稿人", prompt: "你是安全与可信 AI 方向的审稿人。请关注鲁棒性、隐私、攻击面、滥用风险和失效模式。" },
  { name: "产业负责人", prompt: "你是产业界技术负责人。请关注落地价值、维护成本、产品约束、商业风险和收益比。" }
];

const defaultSummaryPrompt = [
  "请结束本轮讨论，并直接回应原始议题。",
  "总结应围绕议题本身，而不是复述讨论过程。",
  "请给出：最终答案、关键依据、讨论后修正过的认识、仍不确定的点、后续最值得验证的方向。",
  "",
  "原始议题：",
  "{topic}"
].join("\n");

initRoleControls();
els.summaryPrompt.value = defaultSummaryPrompt;

els.sendUserBtn.addEventListener("click", sendOrStart);
els.stepBtn.addEventListener("click", () => post("/api/step", {}));
els.autoBtn.addEventListener("click", () => post("/api/auto", { turns: 4 }));
els.endBtn.addEventListener("click", () => post("/api/end", {}));
els.newDiscussionBtn.addEventListener("click", () => post("/api/reset", {}));
els.runToSummaryBtn.addEventListener("click", runToSummary);
els.userMessage.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    sendOrStart();
  }
});

await refresh();
polling = setInterval(refresh, 1500);

async function sendOrStart() {
  const text = els.userMessage.value.trim();
  if (!text) {
    return;
  }
  if (!state?.topic || state.ended) {
    await post("/api/start", {
      topic: text,
      roles: {
        aName: els.roleAName.value,
        aPrompt: els.roleAPrompt.value,
        bName: els.roleBName.value,
        bPrompt: els.roleBPrompt.value
      },
      options: {
        openingSpeaker: els.openingSpeaker.value,
        temporaryChat: els.temporaryChat.checked,
        maxTurns: readMaxTurns(),
        summaryPrompt: els.summaryPrompt.value
      }
    });
  } else {
    await post("/api/user-message", { text });
  }
  els.userMessage.value = "";
}

async function runToSummary() {
  const body = {
    roles: {
      aName: els.roleAName.value,
      aPrompt: els.roleAPrompt.value,
      bName: els.roleBName.value,
      bPrompt: els.roleBPrompt.value
    },
    options: {
      openingSpeaker: els.openingSpeaker.value,
      temporaryChat: els.temporaryChat.checked,
      maxTurns: readMaxTurns(),
      summaryPrompt: els.summaryPrompt.value
    }
  };
  if (!state?.topic || state.ended) {
    const text = els.userMessage.value.trim();
    if (!text) {
      return;
    }
    body.topic = text;
    els.userMessage.value = "";
  }
  await post("/api/run-to-summary", body);
}

async function post(path, body) {
  setBusy(true);
  els.error.textContent = "";
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "请求失败");
    }
    render(data);
  } catch (error) {
    els.error.textContent = error.message;
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function refresh() {
  if (hasActiveSelection()) {
    return;
  }
  const response = await fetch("/api/state");
  render(await response.json());
}

function render(nextState) {
  const wasNearBottom = isNearBottom(els.chat);
  const previousLastId = lastRenderedMessageId;
  state = nextState;
  const active = Boolean(state.topic) && !state.ended;
  const busy = Boolean(state.running);
  const latestId = state.messages.at(-1)?.id ?? 0;
  lastRenderedMessageId = latestId;

  renderModelInfo("a", state.models.a, state.roles.aName, state.roles.aPrompt, els.modelAInfo);
  renderModelInfo("b", state.models.b, state.roles.bName, state.roles.bPrompt, els.modelBInfo);

  els.runState.textContent = state.ended ? "已结束" : busy ? "执行中" : active ? "讨论中" : "未开始";
  els.runState.className = `pill ${busy ? "busy" : active ? "active" : ""}`;
  els.nextSpeaker.textContent = `下一位：${state.nextSpeaker === "a" ? "角色 A" : "角色 B"}`;
  els.messageCount.textContent = `${state.messages.length} 条消息`;
  els.topicTitle.textContent = state.topic
    ? `${state.topic}${state.discussionId ? ` · ${state.discussionId}` : ""}`
    : "等待第一个议题";
  els.error.textContent = state.error || els.error.textContent;

  els.stepBtn.disabled = !active || busy;
  els.autoBtn.disabled = !active || busy;
  els.endBtn.disabled = !active || busy;
  els.newDiscussionBtn.disabled = busy;
  els.runToSummaryBtn.disabled = busy;
  els.sendUserBtn.disabled = busy;
  els.sendUserBtn.textContent = active ? "发送插话" : "发送并开始";

  updateChatMessages(state, wasNearBottom, latestId, previousLastId);
}

function updateChatMessages(nextState, wasNearBottom, latestId, previousLastId) {
  const nextKeys = nextState.messages.map(messageKey);
  const sameDiscussion = renderedDiscussionId === (nextState.discussionId || null);
  const sameMessages = sameDiscussion
    && nextKeys.length === renderedMessageKeys.length
    && nextKeys.every((key, index) => key === renderedMessageKeys[index]);

  if (sameMessages || isUserSelectingTextInsideChat()) {
    return;
  }

  const appendedOnly = sameDiscussion
    && renderedMessageKeys.length > 0
    && nextKeys.length >= renderedMessageKeys.length
    && renderedMessageKeys.every((key, index) => key === nextKeys[index]);

  const newNodes = [];
  if (!appendedOnly) {
    els.chat.innerHTML = "";
    renderedMessageKeys = [];
  }

  if (nextState.messages.length === 0) {
    if (!els.chat.querySelector(".empty")) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "在下方输入第一个问题开始讨论。";
      els.chat.appendChild(empty);
    }
  } else {
    els.chat.querySelector(".empty")?.remove();
  }

  const start = appendedOnly ? renderedMessageKeys.length : 0;
  for (const message of nextState.messages.slice(start)) {
    const item = createMessageElement(message);
    els.chat.appendChild(item);
    newNodes.push(item);
  }

  renderedDiscussionId = nextState.discussionId || null;
  renderedMessageKeys = nextKeys;

  if (newNodes.length > 0) {
    typesetMath(newNodes);
  }

  if (wasNearBottom || (latestId > previousLastId && previousLastId === 0)) {
    els.chat.scrollTop = els.chat.scrollHeight;
  }
}

function createMessageElement(message) {
  const item = document.createElement("article");
  item.className = `message ${message.speaker}`;
  const header = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = message.label;
  const meta = document.createElement("small");
  meta.textContent = `${message.kind}${message.source ? ` · ${message.source}` : ""} · ${new Date(message.createdAt).toLocaleTimeString()}`;
  const copyButton = document.createElement("button");
  copyButton.className = "copy-btn";
  copyButton.type = "button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", () => copyMessage(message.text, copyButton));
  header.append(title, meta, copyButton);
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = message.html ? sanitizeHtml(message.html) : renderMarkdown(message.text);
  item.append(header, body);
  return item;
}

function messageKey(message) {
  return `${message.id}:${message.speaker}:${message.kind}:${message.label}:${message.text}:${message.html || ""}:${message.source || ""}`;
}

function isUserSelectingTextInsideChat() {
  if (!hasActiveSelection()) {
    return false;
  }
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  return els.chat.contains(range.commonAncestorContainer);
}

function hasActiveSelection() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0);
}

function renderModelInfo(slot, model, roleName, rolePrompt, target) {
  target.innerHTML = `
    <div class="model-title">
      <strong>角色 ${slot.toUpperCase()}</strong>
      <span>${escapeHtml(model.label)}</span>
    </div>
    <div class="kv"><span>ID</span><code>${escapeHtml(model.id)}</code></div>
    <div class="kv"><span>连接</span><code>${escapeHtml(model.connection)}${model.endpoint ? ` · ${escapeHtml(model.endpoint)}` : ""}</code></div>
    <div class="kv"><span>官网</span><code>${escapeHtml(model.url)}</code></div>
    <p><strong>${escapeHtml(roleName)}</strong>：${escapeHtml(rolePrompt)}</p>
  `;
}

function setBusy(forceBusy) {
  if (!state) {
    return;
  }
  state.running = forceBusy;
  render(state);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMarkdown(text) {
  const codeBlocks = [];
  const mathBlocks = [];
  let html = escapeHtml(text).replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${code}</code></pre>`);
    return `\u0000CODE_BLOCK_${index}\u0000`;
  });

  html = html
    .replace(/\$\$([\s\S]*?)\$\$/g, (_match, math) => {
      const index = mathBlocks.length;
      mathBlocks.push(`<div class="math-block">$$${math}$$</div>`);
      return `\u0000MATH_BLOCK_${index}\u0000`;
    })
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math) => {
      const index = mathBlocks.length;
      mathBlocks.push(`<div class="math-block">\\[${math}\\]</div>`);
      return `\u0000MATH_BLOCK_${index}\u0000`;
    });

  html = html
    .replace(/^### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^## (.*)$/gm, "<h3>$1</h3>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  html = html.split(/\n{2,}/).map((block) => {
    if (block.startsWith("\u0000CODE_BLOCK_") || block.startsWith("\u0000MATH_BLOCK_")) {
      return block;
    }
    if (/^\s*[-*] /.test(block)) {
      const items = block.split("\n").map((line) => line.replace(/^\s*[-*] /, "").trim()).filter(Boolean);
      return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    }
    if (/^\s*\d+\. /.test(block)) {
      const items = block.split("\n").map((line) => line.replace(/^\s*\d+\. /, "").trim()).filter(Boolean);
      return `<ol>${items.map((item) => `<li>${item}</li>`).join("")}</ol>`;
    }
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("");

  codeBlocks.forEach((block, index) => {
    html = html.replace(`\u0000CODE_BLOCK_${index}\u0000`, block);
  });
  mathBlocks.forEach((block, index) => {
    html = html.replace(`\u0000MATH_BLOCK_${index}\u0000`, block);
  });
  return html;
}

function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, iframe, object, embed, button").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

async function copyMessage(text, button) {
  await navigator.clipboard.writeText(text);
  const previous = button.textContent;
  button.textContent = "已复制";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function typesetMath(nodes) {
  if (!nodes.length) {
    return;
  }
  const mathJax = window.MathJax;
  if (!mathJax) {
    setTimeout(() => typesetMath(nodes), 300);
    return;
  }
  const run = () => mathJax.typesetPromise?.(nodes).catch(() => undefined);
  if (mathJax.startup?.promise) {
    mathJax.startup.promise.then(run).catch(() => undefined);
  } else {
    run();
  }
}

function initRoleControls() {
  fillRoleSelect(els.roleASelect);
  fillRoleSelect(els.roleBSelect);
  els.roleASelect.value = "0";
  els.roleBSelect.value = "1";
  applyPreset("a", rolePresets[0]);
  applyPreset("b", rolePresets[1]);

  els.roleASelect.addEventListener("change", () => {
    applyPreset("a", rolePresets[Number.parseInt(els.roleASelect.value, 10)]);
  });
  els.roleBSelect.addEventListener("change", () => {
    applyPreset("b", rolePresets[Number.parseInt(els.roleBSelect.value, 10)]);
  });
}

function fillRoleSelect(select) {
  rolePresets.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = preset.name;
    select.appendChild(option);
  });
}

function applyPreset(slot, preset) {
  if (slot === "a") {
    els.roleAName.value = preset.name;
    els.roleAPrompt.value = preset.prompt;
  } else {
    els.roleBName.value = preset.name;
    els.roleBPrompt.value = preset.prompt;
  }
}

function readMaxTurns() {
  const value = Number.parseInt(els.maxTurns.value, 10);
  if (!Number.isInteger(value)) {
    return 6;
  }
  return Math.max(1, Math.min(value, 30));
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

window.addEventListener("beforeunload", () => {
  if (polling) {
    clearInterval(polling);
  }
});
