import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DebateConfig, ModelConfig } from "./types.js";

interface ChromeTarget {
  id: string;
  label: string;
  url: string;
  endpoint: string;
  port: number;
  profileDir: string;
}

export async function launchManagedChrome(config: DebateConfig): Promise<void> {
  const targets = [config.models.a, config.models.b]
    .map(toTarget)
    .filter((target): target is ChromeTarget => Boolean(target));

  if (targets.length === 0) {
    throw new Error("No models with connectOverCDP found in config.");
  }

  const launchedPorts = new Set<number>();
  for (const target of targets) {
    if (launchedPorts.has(target.port)) {
      console.log(`[${target.label}] skipped: port ${target.port} is already assigned in this launch.`);
      continue;
    }
    launchedPorts.add(target.port);

    if (await isCdpAlive(target.endpoint)) {
      console.log(`[${target.label}] already running at ${target.endpoint}`);
      continue;
    }

    await mkdir(target.profileDir, { recursive: true });
    const executable = chromeExecutable();
    const args = [
      `--remote-debugging-port=${target.port}`,
      `--user-data-dir=${target.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      target.url
    ];
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    console.log(`[${target.label}] launched Chrome on ${target.endpoint}`);
    console.log(`Profile: ${target.profileDir}`);
  }
}

function toTarget(model: ModelConfig): ChromeTarget | undefined {
  if (!model.connectOverCDP) {
    return undefined;
  }
  const endpoint = new URL(model.connectOverCDP);
  const port = Number.parseInt(endpoint.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${model.id}: connectOverCDP must include an explicit port.`);
  }
  return {
    id: model.id,
    label: model.label ?? model.id,
    url: model.url,
    endpoint: model.connectOverCDP,
    port,
    profileDir: join(process.cwd(), ".debate-cdp-profiles", model.id)
  };
}

async function isCdpAlive(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(700)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function chromeExecutable(): string {
  if (process.platform === "darwin") {
    const path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(path)) {
      return path;
    }
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) {
      return found;
    }
  }
  return "google-chrome";
}
