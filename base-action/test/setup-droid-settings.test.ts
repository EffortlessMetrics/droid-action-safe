#!/usr/bin/env bun

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { setupDroidSettings } from "../src/setup-droid-settings";
import { tmpdir } from "os";
import { mkdir, writeFile, readFile, rm, stat } from "fs/promises";
import { dirname, join } from "path";

const testHomeDir = join(
  tmpdir(),
  "droid-exec-test-home",
  Date.now().toString(),
);
const settingsPath = join(testHomeDir, ".factory", "droid", "settings.json");
const testSettingsDir = join(testHomeDir, ".factory-test");
const testSettingsPath = join(testSettingsDir, "test-settings.json");

describe("setupDroidSettings", () => {
  beforeEach(async () => {
    await mkdir(testHomeDir, { recursive: true });
    await mkdir(testSettingsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testHomeDir, { recursive: true, force: true });
  });

  test("should always set enableAllProjectMcpServers to true when no input", async () => {
    await setupDroidSettings(undefined, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should merge settings from JSON string input", async () => {
    const inputSettings = JSON.stringify({
      model: "gpt-5-codex",
      env: { API_KEY: "test-key" },
    });

    await setupDroidSettings(inputSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.model).toBe("gpt-5-codex");
    expect(settings.env).toEqual({ API_KEY: "test-key" });
  });

  test("should merge settings from file path input", async () => {
    const testSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo test" }],
          },
        ],
      },
      permissions: {
        allow: ["Bash", "Read"],
      },
    };

    await writeFile(testSettingsPath, JSON.stringify(testSettings, null, 2));

    await setupDroidSettings(testSettingsPath, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.hooks).toEqual(testSettings.hooks);
    expect(settings.permissions).toEqual(testSettings.permissions);
  });

  test("should override enableAllProjectMcpServers even if false in input", async () => {
    const inputSettings = JSON.stringify({
      enableAllProjectMcpServers: false,
      model: "test-model",
    });

    await setupDroidSettings(inputSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.model).toBe("test-model");
  });

  test("should throw error for invalid JSON string", async () => {
    expect(() => setupDroidSettings("{ invalid json", testHomeDir)).toThrow();
  });

  test("should throw error for non-existent file path", async () => {
    expect(() =>
      setupDroidSettings("/non/existent/file.json", testHomeDir),
    ).toThrow();
  });

  test("should handle empty string input", async () => {
    await setupDroidSettings("", testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should handle whitespace-only input", async () => {
    await setupDroidSettings("   \n\t  ", testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should merge with existing settings", async () => {
    await setupDroidSettings(
      JSON.stringify({ existingKey: "existingValue" }),
      testHomeDir,
    );

    const newSettings = JSON.stringify({
      newKey: "newValue",
      model: "gpt-5-codex",
    });

    await setupDroidSettings(newSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.existingKey).toBe("existingValue");
    expect(settings.newKey).toBe("newValue");
    expect(settings.model).toBe("gpt-5-codex");
  });

  test("should never print existing credential values while merging settings", async () => {
    const secret = "super-secret-byok-value";
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ customModels: [{ apiKey: secret }] }),
    );

    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await setupDroidSettings(JSON.stringify({ model: "test-model" }), testHomeDir);
      const output = [
        ...logSpy.mock.calls.flat().map(String),
        ...errorSpy.mock.calls.flat().map(String),
      ].join("\n");
      expect(output).not.toContain(secret);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("should persist settings with owner-only file permissions", async () => {
    await setupDroidSettings(JSON.stringify({ model: "test-model" }), testHomeDir);
    const metadata = await stat(settingsPath);
    expect(metadata.mode & 0o777).toBe(0o600);
  });
});
