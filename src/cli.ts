#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { runDebate } from "./debate.js";
import { launchManagedChrome } from "./chrome-launcher.js";
import { startWebServer } from "./server.js";
import { PlaywrightWebModelSession } from "./web-session.js";

interface Args {
  command: string;
  config: string;
  question?: string;
  host: string;
  port: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "web") {
    await startWebServer({ configPath: args.config, host: args.host, port: args.port });
    return;
  }

  const config = await loadConfig(args.config);

  if (args.command === "launch") {
    await launchManagedChrome(config);
    await startWebServer({ configPath: args.config, host: args.host, port: args.port });
    return;
  }

  if (args.command === "browsers") {
    await launchManagedChrome(config);
    return;
  }

  const sessions = {
    a: new PlaywrightWebModelSession(config.models.a, config.browser?.slowMoMs),
    b: new PlaywrightWebModelSession(config.models.b, config.browser?.slowMoMs),
    judge: config.models.judge ? new PlaywrightWebModelSession(config.models.judge, config.browser?.slowMoMs) : undefined
  };

  if (args.command === "login") {
    if (config.models.a.browserProfileDir) {
      await mkdir(dirname(config.models.a.browserProfileDir), { recursive: true });
    }
    if (config.models.b.browserProfileDir) {
      await mkdir(dirname(config.models.b.browserProfileDir), { recursive: true });
    }
    if (config.models.judge?.browserProfileDir) {
      await mkdir(dirname(config.models.judge.browserProfileDir), { recursive: true });
    }
    await sessions.a.open();
    await sessions.b.open();
    if (sessions.judge) {
      await sessions.judge.open();
    }
    console.log("Browser windows are open. Log in manually, then press Ctrl+C when finished.");
    await new Promise(() => undefined);
    return;
  }

  if (args.command !== "debate") {
    usage(1);
  }

  if (!args.question) {
    throw new Error("Missing --question.");
  }

  try {
    const result = await runDebate(config, sessions, args.question);
    console.log(`Debate complete. Transcript: ${config.outputDir}/latest.md`);
    console.log(result.verdict?.answer ?? "");
  } finally {
    await sessions.a.close();
    await sessions.b.close();
    if (sessions.judge) {
      await sessions.judge.close();
    }
  }
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage(0);
  }

  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "debate";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  if (command !== "debate" && command !== "login" && command !== "web" && command !== "browsers" && command !== "launch") {
    usage(1);
  }

  const args: Args = { command, config: "debate.config.json", host: "127.0.0.1", port: 8787 };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];
    if (token === "--config" && next) {
      args.config = next;
      index += 1;
    } else if (token === "--host" && next) {
      args.host = next;
      index += 1;
    } else if (token === "--port" && next) {
      args.port = Number.parseInt(next, 10);
      if (!Number.isInteger(args.port) || args.port <= 0) {
        throw new Error(`Invalid port: ${next}`);
      }
      index += 1;
    } else if (token === "--question" && next) {
      args.question = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function usage(exitCode: number): never {
  console.log([
    "Usage:",
    "  serial-web-debate launch --config debate.config.cdp.example.json --port 8787",
    "  serial-web-debate browsers --config debate.config.cdp.example.json",
    "  serial-web-debate web --config debate.config.json --port 8787",
    "  serial-web-debate login --config debate.config.json",
    "  serial-web-debate debate --config debate.config.json --question \"...\"",
    "",
    "npm scripts:",
    "  npm run launch -- --config debate.config.cdp.example.json",
    "  npm run browsers -- --config debate.config.cdp.example.json",
    "  npm run web -- --config debate.config.json",
    "  npm run login -- --config debate.config.json",
    "  npm run debate -- --config debate.config.json --question \"...\""
  ].join("\n"));
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
