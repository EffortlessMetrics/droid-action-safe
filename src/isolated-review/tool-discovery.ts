import { spawnSync } from "child_process";

export const REVIEW_SERVER_NAME = "review_io";

function collectToolIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  for (const key of ["id", "toolId", "tool_id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      ids.add(candidate.trim());
    }
  }
  for (const child of Object.values(record)) collectToolIds(child, ids);
}

function acceptedIds(server: string, tool: string): string[] {
  return [`${server}___${tool}`, `mcp__${server}__${tool}`];
}

export function selectReviewToolIds(
  catalog: unknown,
  expectedTools: string[],
  server = REVIEW_SERVER_NAME,
): string[] {
  const discovered = new Set<string>();
  collectToolIds(catalog, discovered);

  const selected: string[] = [];
  for (const tool of expectedTools) {
    const accepted = new Set(acceptedIds(server, tool));
    const matches = [...discovered].filter((id) => accepted.has(id));
    if (matches.length !== 1) {
      const visible = [...discovered]
        .filter((id) => id.includes(server))
        .sort()
        .slice(0, 20);
      throw new Error(
        `review_io tool discovery mismatch for ${tool}: expected exactly one advertised identifier; discovered=${JSON.stringify(visible)}`,
      );
    }
    selected.push(matches[0]);
  }
  return selected;
}

export function discoverReviewToolIds(options: {
  executable: string;
  model: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  expectedTools: string[];
  redact: (text: string) => string;
}): string[] {
  const result = spawnSync(
    options.executable,
    [
      "exec",
      "--list-tools",
      "--output-format",
      "json",
      "--disable-builtin-skills",
      "--cwd",
      options.cwd,
      "--model",
      options.model,
    ],
    {
      env: options.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`Droid tool discovery failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Droid tool discovery exited ${result.status}: ${options.redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)}`,
    );
  }

  let catalog: unknown;
  try {
    catalog = JSON.parse(result.stdout ?? "");
  } catch {
    throw new Error(
      `Droid tool discovery returned non-JSON output: ${options.redact(result.stdout ?? "")}`,
    );
  }

  return selectReviewToolIds(catalog, options.expectedTools);
}
