import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

describe("isolated review MCP tool IDs", () => {
  it("uses Droid's canonical mcp__server__tool identifiers", async () => {
    const runPhase = await readFile(
      path.join(ROOT, "src", "isolated-review", "run-phase.ts"),
      "utf8",
    );

    expect(runPhase).toContain('const MCP_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;');
    expect(runPhase).toContain('`${MCP_TOOL_PREFIX}read_artifact`');
    expect(runPhase).toContain('`${MCP_TOOL_PREFIX}read_repo_file`');
    expect(runPhase).toContain('`${MCP_TOOL_PREFIX}write_candidates`');
    expect(runPhase).toContain('`${MCP_TOOL_PREFIX}write_validated`');
    expect(runPhase).not.toContain("review_io___");
  });
});
