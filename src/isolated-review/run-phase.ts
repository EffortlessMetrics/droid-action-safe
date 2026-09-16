#!/usr/bin/env bun

import * as core from "@actions/core";
import { spawn, spawnSync } from "child_process";
import { access, readFile } from "fs/promises";
import readline from "readline";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
  assertDocumentIdentity,
} from "./schemas";
import { REVIEW_SERVER_NAME, discoverReviewToolIds } from "./tool-discovery";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function phaseTimeoutMs(): number {
  const raw = required("REVIEW_PHASE_TIMEOUT_MINUTES");
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 20) {
    throw new Error(
      "REVIEW_PHASE_TIMEOUT_MINUTES must be an integer from 1 through 20",
    );
  }
  return minutes * 60_000;
}

function secretFreeEnv(factoryApiKey: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  const retained = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "BUN_INSTALL",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];
  for (const key of retained) {
    if (process.env[key]) child[key] = process.env[key];
  }
  child.FACTORY_API_KEY = factoryApiKey;
  child.FACTORY_DROID_AUTO_UPDATE_ENABLED = "false";
  child.CI = "true";
  child.NO_COLOR = "1";
  return child;
}

function redact(text: string, secrets: string[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = sanitized.replace(
    /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );
  return sanitized.slice(0, 8_000);
}

async function runDroid(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  secrets: string[],
  timeoutMs: number,
): Promise<void> {
  const child = spawn(executable, args, {
    cwd: env.HOME,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let sawResult = false;
  let resultFailed = false;
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "system" && value.subtype === "init") {
        core.info(
          JSON.stringify({
            type: "system",
            subtype: "init",
            model: value.model ?? "unknown",
          }),
        );
      } else if (value.type === "result") {
        sawResult = true;
        resultFailed = value.is_error === true || value.subtype === "error";
        core.info(
          JSON.stringify({
            type: "result",
            subtype: value.subtype,
            is_error: value.is_error,
            duration_ms: value.duration_ms,
            num_turns: value.num_turns,
            total_cost_usd: value.total_cost_usd,
            permission_denials: value.permission_denials,
          }),
        );
      }
    } catch {
      // Non-JSON progress output is deliberately suppressed. The review model
      // never receives secrets, but its generated text is still untrusted.
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
  });

  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(deadline);
    if (forceKill) clearTimeout(forceKill);
    lines.close();
  }

  if (timedOut) {
    throw new Error(`Droid review phase timed out after ${timeoutMs} ms`);
  }
  if (exitCode !== 0 || resultFailed || !sawResult) {
    throw new Error(
      `Droid review phase failed (exit=${exitCode}, result=${sawResult}, result_error=${resultFailed}): ${redact(stderr, secrets)}`,
    );
  }
}

async function main(): Promise<void> {
  const phase = required("REVIEW_PHASE");
  if (phase !== "candidate" && phase !== "validator") {
    throw new Error("REVIEW_PHASE must be candidate or validator");
  }

  const factoryApiKey = required("FACTORY_API_KEY");
  core.setSecret(factoryApiKey);
  const executable = required("DROID_EXECUTABLE");
  const wrapper = required("REVIEW_IO_WRAPPER");
  const model = required("REVIEW_MODEL");
  const timeoutMs = phaseTimeoutMs();
  const state = ReviewStateSchema.parse(
    JSON.parse(await readFile(required("REVIEW_STATE_PATH"), "utf8")),
  );
  const env = secretFreeEnv(factoryApiKey);

  if (phase === "candidate") {
    const registration = spawnSync(
      executable,
      ["mcp", "add", REVIEW_SERVER_NAME, wrapper, "--type", "stdio"],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (registration.status !== 0) {
      throw new Error(
        `failed to register isolated MCP server: ${redact(`${registration.stdout ?? ""}\n${registration.stderr ?? ""}`, [factoryApiKey])}`,
      );
    }
  }

  const target =
    phase === "candidate" ? state.candidatesPath : state.validatedPath;
  try {
    await access(target);
    throw new Error(`refusing stale review output at ${target}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing stale")) {
      throw error;
    }
  }

  const prompt =
    phase === "candidate"
      ? state.candidatePromptPath
      : state.validatorPromptPath;
  const writeTool =
    phase === "candidate" ? "write_candidates" : "write_validated";
  const tools = discoverReviewToolIds({
    executable,
    model,
    cwd: state.isolatedCwd,
    env,
    expectedTools: ["read_artifact", "read_repo_file", writeTool],
    redact: (text) => redact(text, [factoryApiKey]),
  });
  core.info(`Using isolated review tools: ${tools.join(",")}`);

  await runDroid(
    executable,
    [
      "exec",
      "--output-format",
      "stream-json",
      "--auto",
      "low",
      "--disable-builtin-skills",
      "--cwd",
      state.isolatedCwd,
      "--restrict-tools",
      tools.join(","),
      "--model",
      model,
      "-f",
      prompt,
    ],
    env,
    [factoryApiKey],
    timeoutMs,
  );

  if (phase === "candidate") {
    const document = CandidateDocumentSchema.parse(
      JSON.parse(await readFile(target, "utf8")),
    );
    assertDocumentIdentity(state, document.meta);
    core.info(
      `Candidate generation produced ${document.comments.length} item(s).`,
    );
  } else {
    const document = ValidatedDocumentSchema.parse(
      JSON.parse(await readFile(target, "utf8")),
    );
    assertDocumentIdentity(state, document.meta);
    core.info(`Validation produced ${document.results.length} disposition(s).`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(
    `isolated ${process.env.REVIEW_PHASE ?? "review"} phase failed: ${message}`,
  );
  process.exitCode = 1;
});
