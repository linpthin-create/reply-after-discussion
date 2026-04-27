# Serial Web Debate

Serial Web Debate 是一个本地网页端工具，用来让两个大模型官网网页端进行串行讨论。它不是把同一个问题并行发给多个模型做横向比较，而是让两个模型在各自官网会话中轮流交换意见，逐步深化对议题的理解，最后由开场者总结收束并直接回答原始议题。

## Features

- 串行讨论：A 开场，B 评估、查漏补缺、纠错，之后按轮次继续交换意见。
- 官网网页端：通过 Playwright/CDP 操作真实浏览器中的 ChatGPT、Gemini 等官网页面。
- 用户可插话：讨论中可随时发送补充观点、约束、反例或追问。
- 可编辑角色：每个参与者有显示名和“首次前缀 prompt”，后续轮次只转发新增消息。
- 可编辑总结 prompt：最终总结 prompt 显示在 UI 中，可自定义，支持 `{topic}` 占位符。
- 一键流程：一键启动浏览器和 Web UI；一键讨论到设定轮数并总结。
- 独立存档：每次讨论都有独立 `discussion-id` 和 Markdown/JSON 存档。
- 公式和格式：默认从官网回答 DOM 读取原始内容，自动提取流程不触发官网复制按钮，不污染系统剪贴板。

## How It Works

```text
用户输入议题
-> 开场者收到“首次前缀 prompt + 议题”
-> 开场者在自己的官网会话中回答
-> 工具读取开场者回答
-> 另一位参与者收到自己的首次前缀 prompt + 新增消息
-> 后续轮次只转发新增群聊消息，不重复长前缀
-> 用户可随时插话
-> 达到设定轮数或用户点击结束
-> 开场者使用总结 prompt 回到原始议题并给出最终答案
```

## Safety and Boundaries

本工具不会处理账号密码，不会绕过登录、验证码、风控或网站限制。首次使用需要你在打开的浏览器里手动登录对应 AI 官网。请遵守各服务条款。

## Requirements

- Node.js 18+
- macOS/Linux/Windows
- Google Chrome，推荐使用 CDP 方式连接真实 Chrome

## Install

```bash
npm install
```

如果你使用 Playwright 自带 Chromium：

```bash
npx playwright install chromium
```

推荐使用真实 Chrome + CDP，通常不需要上面这一步。

## Quick Start

推荐直接使用 CDP 示例配置：

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

然后打开：

```text
http://127.0.0.1:8787
```

第一次运行时，工具会打开两个托管 Chrome profile。你需要分别在两个 Chrome 窗口里登录对应 AI 官网。之后这些登录状态会保存在：

```text
.debate-cdp-profiles/chatgpt
.debate-cdp-profiles/gemini
```

只要不删除这些目录，后续通常不需要重新登录。

也可以分两步启动：

```bash
npm run browsers -- --config debate.config.cdp.example.json
npm run web -- --config debate.config.cdp.example.json --port 8787
```

## UI Usage

1. 在左侧选择开场方。
2. 选择是否开始时新建官网对话。
3. 设置对话轮数。
4. 选择或编辑两个参与者的显示名和首次前缀 prompt。
5. 编辑最终总结 prompt，可使用 `{topic}` 代表原始议题。
6. 在底部输入第一条消息，它会成为讨论议题。
7. 点击“发送 / 开始”手动启动，或点击“一键讨论到总结”自动执行完整流程。

常用按钮：

- `发送 / 开始`: 第一条消息创建议题；讨论中发送用户插话。
- `下一位发言`: 只推进下一位参与者发言。
- `自动 4 轮`: 连续推进 4 次轮流发言。
- `一键讨论到总结`: 按设定轮数自动讨论，最后由开场者总结。
- `结束并总结`: 立即由开场者总结收束。
- `开启新讨论`: 清空当前界面，下一次发送会创建新讨论和新存档。

## Configuration

CDP 示例：

```json
{
  "rounds": 2,
  "outputDir": "runs",
  "models": {
    "a": {
      "id": "chatgpt",
      "label": "ChatGPT",
      "url": "https://chatgpt.com/",
      "connectOverCDP": "http://127.0.0.1:9222",
      "responseTimeoutMs": 180000,
      "waitForIdleMs": 15000,
      "extraSettleMs": 3000,
      "selectors": {
        "promptBox": ["#prompt-textarea", "textarea", "[contenteditable='true']", "[role='textbox']"],
        "answerBlocks": ["[data-message-author-role='assistant']"],
        "answerMarkdown": [
          "[data-message-author-role='assistant'] .markdown",
          "[data-message-author-role='assistant'] [class*='markdown']"
        ]
      }
    },
    "b": {
      "id": "gemini",
      "label": "Gemini",
      "url": "https://gemini.google.com/app",
      "connectOverCDP": "http://127.0.0.1:9223",
      "responseTimeoutMs": 180000,
      "waitForIdleMs": 15000,
      "extraSettleMs": 3000
    }
  }
}
```

重要字段：

- `id`: 内部模型标识。
- `label`: UI 中显示的模型名称。
- `url`: AI 官网地址。
- `connectOverCDP`: 连接到 Chrome DevTools Protocol 调试端口。
- `browserProfileDir`: 不使用 CDP 时的 Playwright profile 目录。
- `browserChannel`: 使用本机 Chrome/Edge，例如 `chrome` 或 `msedge`。
- `responseTimeoutMs`: 等待回答最大时间。
- `waitForIdleMs`: 回答稳定多久后认为完成。
- `extraSettleMs`: 完成前额外等待确认。

选择器字段：

- `selectors.promptBox`: 输入框选择器。
- `selectors.submitButton`: 发送按钮选择器。
- `selectors.answerBlocks`: assistant 回答块选择器。
- `selectors.answerMarkdown`: 回答正文容器选择器，作为 fallback。
- `selectors.stopButton`: 停止生成按钮选择器。
- `selectors.newChatButton`: 新对话按钮选择器。

## Chrome CDP Mode

普通已打开的 Chrome 标签页不能被工具直接接管。浏览器必须在启动时开启 CDP 调试端口。

手动启动示例：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/serial-ai-chrome-a

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/serial-ai-chrome-b
```

项目也提供自动启动：

```bash
npm run browsers -- --config debate.config.cdp.example.json
```

或者一键启动浏览器和 UI：

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

## Output

最近一次讨论：

```text
runs/group-chat-latest.md
runs/group-chat-latest.json
```

每次讨论的独立存档：

```text
runs/discussions/<discussion-id>/group-chat.md
runs/discussions/<discussion-id>/group-chat.json
```

`latest` 只是快捷指针；每个讨论自己的完整记录不会被覆盖。

## Answer Extraction Strategy

默认读取顺序：

1. 网络响应候选：监听官网页面返回的 JSON/SSE/batchexecute 等文本响应，解析其中与可见回答匹配的原始 Markdown/LaTeX。
2. 页面状态探测：在回答块及其祖先节点的 React/前端状态中搜索与可见回答匹配的原始 Markdown 字符串。
3. DOM 提取：从 `answerMarkdown` / `answerBlocks` 读取页面已渲染内容，反推 Markdown、公式、代码块、表格等。
4. `innerText` fallback：最后退回纯文本读取。

默认自动提取流程不会点击官网复制按钮，也不会读写系统剪贴板。UI 中每条消息旁的“复制”按钮只会在用户手动点击时写入剪贴板。

UI 展示时不会直接展示原始 Markdown，而是渲染为 HTML，并用 MathJax 显示公式。

消息头中的来源标记用于调试：

- `state`: 从页面状态中找到了疑似原始 Markdown。
- `network`: 从官网网络响应中找到了疑似原始 Markdown/LaTeX。
- `dom`: 从已渲染 DOM 反推出内容。
- `text`: 纯文本兜底。

## Troubleshooting

### 登录提示“不安全浏览器”

推荐使用 CDP 模式连接真实 Chrome：

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

如果仍被拒绝，这是官网风控策略。工具不会绕过验证码或账号安全限制。

### 无法发送消息

检查：

- `selectors.promptBox`
- `selectors.submitButton`

### 无法读取回答

检查：

- `selectors.answerBlocks`
- `selectors.answerMarkdown`
ChatGPT/Gemini 官网 DOM 经常变化，选择器可能需要更新。

### 回答被截断或长时间超时

调高：

```json
{
  "waitForIdleMs": 20000,
  "extraSettleMs": 5000,
  "responseTimeoutMs": 300000
}
```

### 公式显示异常

若消息来源显示为 `state` 但公式仍异常，通常是官网状态里本身保存的格式不同。若来源显示为 `dom` 或 `text`，优先调整 `selectors.answerMarkdown`，让它指向官网回答正文容器，而不是整条消息外壳。

## Development

```bash
npm run check
npm run build
node --check public/app.js
```

主要文件：

- `src/web-session.ts`: 浏览器连接、输入发送、回答读取。
- `src/group-chat.ts`: 串行群聊状态机和存档。
- `src/group-prompts.ts`: prompt 组装。
- `src/server.ts`: 本地 HTTP API 和静态页面服务。
- `public/`: Web UI。
- `debate.config.cdp.example.json`: 推荐配置示例。

## Notes

- 本工具面向个人本地使用。
- 不建议把自己的浏览器 profile、cookies、运行存档提交到 GitHub。
- `.debate-cdp-profiles/`, `.debate-profiles/`, `runs/` 已在 `.gitignore` 中忽略。
