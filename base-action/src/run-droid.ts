import * as core from "@actions/core";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";
import { parse as parseShellArgs } from "shell-quote";

const execAsync = promisify(exec);

function baseArgs(): string[] {
  const args = ["exec", "--output-format", "stream-json"];
  // General implementation/fill modes preserve the upstream compatibility
  // behavior. Model-bearing review modes deliberately keep permission checks
  // active and rely on --auto low + --restrict-tools instead.
  if (process.env.DROID_SAFE_REVIEW_MODE !== "true") {
    args.push("--skip-permissions-unsafe");
  }
  return args;
}

/**
 * Sanitizes JSON output to remove sensitive information when full output is disabled
 * Returns a safe summary message or null if the message should be completely suppressed
 */
function sanitizeJsonOutput(
  jsonObj: any,
  showFullOutput: boolean,
): string | null {
  if (showFullOutput) {
    return JSON.stringify(jsonObj, null, 2);
  }

  const type = jsonObj.type;
  const subtype = jsonObj.subtype;

  if (type === "system" && subtype === "init") {
    return JSON.stringify(
      {
        type: "system",
        subtype: "init",
        message: "Droid Exec initialized",
        model: jsonObj.model || "unknown",
      },
      null,
      2,
    );
  }

  if (type === "result") {
    return JSON.stringify(
      {
        type: "result",
        subtype: jsonObj.subtype,
        is_error: jsonObj.is_error,
        duration_ms: jsonObj.duration_ms,
        num_turns: jsonObj.num_turns,
        total_cost_usd: jsonObj.total_cost_usd,
        permission_denials: jsonObj.permission_denials,
      },
      null,
      2,
    );
  }

  return null;
}

export type DroidOptions = {
  droidArgs?: string;
  reasoningEffort?: string;
  pathToDroidExecutable?: string;
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: string;
  mcpTools?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  showFullOutput?: string;
};

type PreparedConfig = {
  droidArgs: string[];
  promptPath: string;
  env: Record<string, string>;
};

export function prepareRunConfig(
  promptPath: string,
  options: DroidOptions,
): PreparedConfig {
  const droidArgs = baseArgs();

  if (options.reasoningEffort?.trim()) {
    droidArgs.push("--reasoning-effort", options.reasoningEffort.trim());
  }

  if (options.droidArgs?.trim()) {
    const parsed = parseShellArgs(options.droidArgs);
    const customArgs = parsed.filter(
      (arg): arg is string => typeof arg === "string",
    );
    droidArgs.push(...customArgs);
  }

  droidArgs.push("-f", promptPath);

  const customEnv: Record<string, string> = {};

  if (process.env.INPUT_ACTION_INPUTS_PRESENT) {
    customEnv.GITHUB_ACTION_INPUTS = process.env.INPUT_ACTION_INPUTS_PRESENT;
  }

  return {
    droidArgs,
    promptPath,
    env: customEnv,
  };
}

export async function runDroid(promptPath: string, options: DroidOptions) {
  if (options.mcpTools && options.mcpTools.trim()) {
    try {
      const cfg = JSON.parse(options.mcpTools);
      const servers = cfg?.mcpServers || {};
      const serverNames = Object.keys(servers);

      if (serverNames.length > 0) {
        if (process.env.DROID_SAFE_REVIEW_MODE === "true") {
          throw new Error(
            "restricted review mode refuses model-side MCP server registration",
          );
        }
        console.log(
          `Registering ${serverNames.length} MCP servers: ${serverNames.join(", ")}`,
        );

        for (const [name, def] of Object.entries<any>(servers)) {
          const cmd = [def.command, ...(def.args || [])]
            .filter(Boolean)
            .join(" ");

          try {
            await execAsync(`droid mcp remove ${name}`);
          } catch (_) {
            // Ignore - server might not exist
          }

          const envFlags = Object.entries(def.env || {})
            .map(([k, v]) => `--env ${k}=${String(v)}`)
            .join(" ");

          const addCmd = `droid mcp add ${name} "${cmd}" ${envFlags}`.trim();

          try {
            await execAsync(addCmd, { env: { ...process.env } });
            console.log(`  ✓ Registered MCP server: ${name}`);
          } catch (e: any) {
            console.error(
              `  ✗ Failed to register MCP server ${name}:`,
              e.message,
            );
            throw e;
          }
        }
      }
    } catch (e) {
      console.error("Failed to register MCP servers:", e);
      throw new Error(`MCP server registration failed: ${e}`);
    }
  }

  const config = prepareRunConfig(promptPath, options);

  let promptSize = "unknown";
  try {
    const stats = await stat(config.promptPath);
    promptSize = stats.size.toString();
  } catch (_) {
    // Ignore error
  }

  console.log(`Prompt file size: ${promptSize} bytes`);

  const customEnvKeys = Object.keys(config.env).filter(
    (key) => key !== "DROID_ACTION_INPUTS_PRESENT",
  );
  if (customEnvKeys.length > 0) {
    console.log(`Custom environment variables: ${customEnvKeys.join(", ")}`);
  }

  if (options.droidArgs && options.droidArgs.trim() !== "") {
    console.log(`Custom Droid arguments: ${options.droidArgs}`);

    const enabledToolsMatch = options.droidArgs.match(
      /--enabled-tools\s+["\']?([^"\']+)["\']?/,
    );
    if (enabledToolsMatch && enabledToolsMatch[1]) {
      const tools = enabledToolsMatch[1].split(",").map((t) => t.trim());
      const oldStyleTools = tools.filter((t) => t.startsWith("mcp__"));

      if (oldStyleTools.length > 0) {
        console.warn(
          `Warning: Found ${oldStyleTools.length} tools with deprecated mcp__ prefix. Update to new pattern (e.g., github_comment___update_droid_comment)`,
        );
      }
    }
  }

  console.log(`Running Droid Exec with prompt from file: ${config.promptPath}`);
  console.log(`Full command: droid ${config.droidArgs.join(" ")}`);

  const droidExecutable = options.pathToDroidExecutable || "droid";

  const droidProcess = spawn(droidExecutable, config.droidArgs, {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      ...config.env,
    },
  });

  droidProcess.on("error", (error) => {
    console.error("Error spawning Droid process:", error);
  });

  const isDebugMode = process.env.ACTIONS_STEP_DEBUG === "true";
  let showFullOutput = options.showFullOutput === "true" || isDebugMode;

  if (isDebugMode && options.showFullOutput !== "false") {
    console.log("Debug mode detected - showing full output");
    showFullOutput = true;
  } else if (!showFullOutput) {
    console.log("Running Droid Exec (full output hidden for security)...");
    console.log(
      "Rerun in debug mode or enable `show_full_output: true` in your workflow file for full output.",
    );
  }

  let sessionId: string | undefined;
  droidProcess.stdout.on("data", (data) => {
    const text = data.toString();
    const lines = text.split("\n");
    lines.forEach((line: string, index: number) => {
      if (line.trim() === "") return;

      try {
        const parsed = JSON.parse(line);
        if (!sessionId && typeof parsed === "object" && parsed !== null) {
          const detectedSessionId = parsed.session_id;
          if (
            typeof detectedSessionId === "string" &&
            detectedSessionId.trim()
          ) {
            sessionId = detectedSessionId;
            console.log(`Detected Droid session: ${sessionId}`);
          }
        }
        const sanitizedOutput = sanitizeJsonOutput(parsed, showFullOutput);

        if (sanitizedOutput) {
          process.stdout.write(sanitizedOutput);
          if (index < lines.length - 1 || text.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }
      } catch (_) {
        if (showFullOutput) {
          process.stdout.write(line);
          if (index < lines.length - 1 || text.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }
      }
    });
  });

  droidProcess.stdout.on("error", (error) => {
    console.error("Error reading Droid stdout:", error);
  });

  const exitCode = await new Promise<number>((resolve) => {
    droidProcess.on("close", (code) => {
      resolve(code || 0);
    });

    droidProcess.on("error", (error) => {
      console.error("Droid process error:", error);
      resolve(1);
    });
  });

  if (exitCode === 0) {
    core.setOutput("conclusion", "success");
    return;
  }

  core.setOutput("conclusion", "failure");
  process.exit(exitCode);
}
