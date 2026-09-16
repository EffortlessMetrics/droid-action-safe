import { describe, expect, it } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";
import { selectReviewToolIds } from "../src/isolated-review/tool-discovery";

const ROOT = path.resolve(import.meta.dir, "..");
const EXPECTED = ["read_artifact", "read_repo_file", "write_candidates"];

describe("isolated review MCP tool discovery", () => {
  it("accepts the live Droid normalized identifier shape when advertised", () => {
    const catalog = {
      tools: EXPECTED.map((tool) => ({ id: `review_io___${tool}` })),
    };

    expect(selectReviewToolIds(catalog, EXPECTED)).toEqual(
      EXPECTED.map((tool) => `review_io___${tool}`),
    );
  });

  it("accepts the documented MCP identifier shape when advertised", () => {
    const catalog = {
      result: {
        tools: EXPECTED.map((tool) => ({ id: `mcp__review_io__${tool}` })),
      },
    };

    expect(selectReviewToolIds(catalog, EXPECTED)).toEqual(
      EXPECTED.map((tool) => `mcp__review_io__${tool}`),
    );
  });

  it("rejects missing, duplicate, or other-server identifiers", () => {
    expect(() =>
      selectReviewToolIds(
        {
          tools: [
            { id: "review_io___read_artifact" },
            { id: "review_io___read_repo_file" },
          ],
        },
        EXPECTED,
      ),
    ).toThrow("write_candidates");

    expect(() =>
      selectReviewToolIds(
        {
          tools: [
            { id: "review_io___read_artifact" },
            { id: "mcp__review_io__read_artifact" },
            { id: "review_io___read_repo_file" },
            { id: "review_io___write_candidates" },
          ],
        },
        EXPECTED,
      ),
    ).toThrow("read_artifact");

    expect(() =>
      selectReviewToolIds(
        {
          tools: EXPECTED.map((tool) => ({ id: `other___${tool}` })),
        },
        EXPECTED,
      ),
    ).toThrow("read_artifact");
  });

  it("discovers at runtime and blocks until MCP loading settles", async () => {
    const runPhase = await readFile(
      path.join(ROOT, "src", "isolated-review", "run-phase.ts"),
      "utf8",
    );
    const action = await readFile(
      path.join(ROOT, "isolated-review", "action.yml"),
      "utf8",
    );

    expect(runPhase).toContain("discoverReviewToolIds");
    expect(runPhase).toContain('"--list-tools"');
    expect(runPhase).toContain('"--restrict-tools"');
    expect(runPhase).not.toContain("review_io___read_artifact");
    expect(runPhase).not.toContain("mcp__review_io__read_artifact");
    expect(action).toContain('"blockOnMcpLoad": True');
  });
});
