# Reply After Discussion

[简体中文](README.zh-CN.md)

Reply After Discussion is a local web tool for serial discussions between two official AI web interfaces, such as ChatGPT and Gemini. Instead of sending the same question to multiple models in parallel, it keeps each model in its own browser session and lets them exchange views turn by turn. The opener summarizes at the end and directly answers the original topic.

## Features

- Serial discussion: one participant opens, the other reviews, corrects, and adds missing considerations, then both continue by turns.
- Official web UI automation: controls real browser pages through Playwright and Chrome DevTools Protocol.
- User interjections: add your own constraints, counterexamples, or opinions during the discussion.
- Editable roles: each participant has a display name and a first-turn role prompt; later turns only pass new chat messages.
- Editable summary prompt: the final prompt is visible in the UI and supports the `{topic}` placeholder.
- One-click workflow: launch browser profiles and the local Web UI, then run a discussion to summary.
- Independent archives: every discussion has its own Markdown and JSON archive.
- Format extraction: the automatic extraction path reads from network responses, page state, or DOM without clicking official copy buttons or touching the system clipboard.

## How It Works

```text
User enters a topic
-> Opener receives first role prompt + topic
-> Opener answers in its official web session
-> Tool reads the answer
-> Other participant receives its first role prompt + new message
-> Later turns pass only new group-chat messages
-> User may interject at any time
-> Max turns reached, or user ends the discussion
-> Opener summarizes and answers the original topic
```

## Safety and Boundaries

This tool does not handle account passwords and does not bypass login, captcha, account risk checks, or service restrictions. You must manually log in to each AI website in the opened browser profiles. Use it only in ways allowed by the relevant services.

## Requirements

- Node.js 18+
- macOS, Linux, or Windows
- Google Chrome, recommended for CDP mode

## Install

```bash
npm install
```

If you want to use Playwright's bundled Chromium:

```bash
npx playwright install chromium
```

Using real Chrome through CDP is recommended and usually does not require installing Playwright browsers.

## Quick Start

Use the CDP example configuration:

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

Then open:

```text
http://127.0.0.1:8787
```

On the first run, the tool opens two managed Chrome profiles. Log in to the target AI websites in those windows. Login state is stored in:

```text
.debate-cdp-profiles/chatgpt
.debate-cdp-profiles/gemini
```

As long as you do not delete these directories, you usually do not need to log in again.

You can also start the browser profiles and the Web UI separately:

```bash
npm run browsers -- --config debate.config.cdp.example.json
npm run web -- --config debate.config.cdp.example.json --port 8787
```

## UI Usage

1. Choose the opening participant.
2. Choose whether to start with a new official-web conversation.
3. Set the maximum number of discussion turns.
4. Select or edit both participants' display names and first-turn role prompts.
5. Edit the final summary prompt. Use `{topic}` for the original topic.
6. Enter the first message at the bottom. It becomes the discussion topic.
7. Click `Send / Start` for manual control, or `Run to Summary` for the full flow.

Common actions:

- `Send / Start`: creates the topic, or sends a user interjection during an active discussion.
- `Next Speaker`: advances one model turn.
- `Auto 4 Turns`: advances four model turns.
- `Run to Summary`: runs until the configured max turns and then summarizes.
- `End and Summarize`: immediately asks the opener to summarize.
- `New Discussion`: clears the current UI state and starts a new archive on the next topic.

## Configuration

CDP example:

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

Important fields:

- `id`: internal model ID.
- `label`: model name shown in the UI.
- `url`: official AI website URL.
- `connectOverCDP`: Chrome DevTools Protocol endpoint.
- `browserProfileDir`: Playwright profile directory when not using CDP.
- `browserChannel`: local browser channel, such as `chrome` or `msedge`.
- `responseTimeoutMs`: maximum time to wait for an answer.
- `waitForIdleMs`: how long the answer must stay stable before it is considered complete.
- `extraSettleMs`: extra wait before final extraction.

Selector fields:

- `selectors.promptBox`: input box selectors.
- `selectors.submitButton`: send button selectors.
- `selectors.answerBlocks`: assistant answer block selectors.
- `selectors.answerMarkdown`: answer body selectors, used as a fallback.
- `selectors.stopButton`: stop-generating button selectors.
- `selectors.newChatButton`: new-chat button selectors.

## Chrome CDP Mode

A normal already-open Chrome tab cannot be controlled by the tool. Chrome must be started with a CDP debugging port.

Manual launch example:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/serial-ai-chrome-a

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/serial-ai-chrome-b
```

The project also provides browser launch helpers:

```bash
npm run browsers -- --config debate.config.cdp.example.json
```

Or launch browsers and the UI together:

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

## Output

Latest discussion shortcut:

```text
runs/group-chat-latest.md
runs/group-chat-latest.json
```

Per-discussion archives:

```text
runs/discussions/<discussion-id>/group-chat.md
runs/discussions/<discussion-id>/group-chat.json
```

The `latest` files are shortcuts only. Each discussion archive is kept separately.

## Answer Extraction Strategy

Default extraction order:

1. Network candidates: listen to official-page JSON, SSE, batchexecute, and other text responses, then match raw Markdown/LaTeX candidates against the visible answer.
2. Page state probing: search React/front-end state near the answer block for raw Markdown strings matching the visible answer.
3. DOM extraction: read rendered content from `answerMarkdown` / `answerBlocks` and reconstruct Markdown, formulas, code blocks, and tables.
4. `innerText` fallback: read plain text as the final fallback.

The automatic extraction flow does not click official copy buttons and does not read or write the system clipboard. The UI message-level `Copy` button writes to the clipboard only when the user clicks it.

The UI renders Markdown as HTML and uses MathJax for formulas.

Message source labels are useful for debugging:

- `network`: raw Markdown/LaTeX candidate found in an official network response.
- `state`: raw Markdown candidate found in page state.
- `dom`: content reconstructed from rendered DOM.
- `text`: plain-text fallback.

## Troubleshooting

### Login Shows "Unsafe Browser"

Use CDP mode with real Chrome:

```bash
npm run launch -- --config debate.config.cdp.example.json --port 8787
```

If the provider still blocks login, that is a website-side risk-control decision. This tool does not bypass captchas or account security checks.

### Cannot Send Messages

Check:

- `selectors.promptBox`
- `selectors.submitButton`

### Cannot Read Answers

Check:

- `selectors.answerBlocks`
- `selectors.answerMarkdown`

Official ChatGPT and Gemini DOM structures change frequently, so selectors may need updates.

### Answers Are Truncated or Timeout

Increase:

```json
{
  "waitForIdleMs": 20000,
  "extraSettleMs": 5000,
  "responseTimeoutMs": 300000
}
```

### Formula Rendering Is Wrong

If the source label is `network`, the captured response may still use provider-specific formula escaping. If it is `dom` or `text`, adjust `selectors.answerMarkdown` so it points to the answer body rather than the whole message shell.

## Development

```bash
npm run check
npm run build
node --check public/app.js
```

Main files:

- `src/web-session.ts`: browser connection, prompt input, answer extraction.
- `src/group-chat.ts`: serial group-chat state machine and archives.
- `src/group-prompts.ts`: prompt assembly.
- `src/server.ts`: local HTTP API and static Web UI server.
- `public/`: Web UI.
- `debate.config.cdp.example.json`: recommended example configuration.

## Notes

- This project is intended for local personal use.
- Do not commit your browser profiles, cookies, local config, or run archives.
- `.debate-cdp-profiles/`, `.debate-profiles/`, `runs/`, and `debate.config.json` are ignored by `.gitignore`.
