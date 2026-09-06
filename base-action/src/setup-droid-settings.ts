import { homedir } from "os";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

type DroidSettings = Record<string, unknown>;

function requiredPath(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required for restricted review mode`);
  }
  return resolve(trimmed);
}

/** Apply deterministic file/MCP controls for model-bearing review passes. */
export function applyRestrictedReviewSettings(
  settings: DroidSettings,
  options: {
    home: string;
    settingsPath: string;
    workspace?: string;
    promptFile?: string;
  },
): DroidSettings {
  const workspace = requiredPath("GITHUB_WORKSPACE", options.workspace);
  const promptDir = dirname(requiredPath("INPUT_PROMPT_FILE", options.promptFile));
  const home = resolve(options.home);
  const settingsPath = resolve(options.settingsPath);

  return {
    ...settings,
    // PR-controlled project MCP definitions are not part of automatic review.
    enableAllProjectMcpServers: false,
    sandbox: {
      enabled: true,
      mode: "per-command",
      filesystem: {
        // Review may inspect only the checked-out PR plus precomputed artifacts.
        allowRead: [workspace, promptDir],
        // The model may write only candidate/validated JSON beside the prompt.
        allowWrite: [promptDir],
        // Explicit denies document and enforce the credential boundary even if
        // a future sandbox implementation broadens an allow rule.
        denyRead: [
          settingsPath,
          `${home}/.factory/settings.json`,
          `${home}/.factory/settings.local.json`,
          `${home}/.ssh`,
          `${home}/.aws`,
          `${home}/.config/gh`,
          `${home}/.config/gcloud`,
          `${home}/.kube`,
          "/proc",
          "/run/secrets",
          "/var/run/secrets",
        ],
      },
    },
  };
}

export async function setupDroidSettings(
  settingsInput?: string,
  homeDir?: string,
) {
  const home = homeDir ?? homedir();
  const settingsDir = `${home}/.factory/droid`;
  const settingsPath = `${settingsDir}/settings.json`;
  console.log(`Setting up Droid settings at: ${settingsPath}`);

  console.log(`Creating Droid settings directory...`);
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });

  let settings: DroidSettings = {};
  try {
    const existingSettings = await readFile(settingsPath, "utf8");
    if (existingSettings.trim()) {
      settings = JSON.parse(existingSettings);
      console.log(`Found existing Droid settings file`);
    } else {
      console.log(`Settings file exists but is empty`);
    }
  } catch {
    console.log(`No existing settings file found, creating new one`);
  }

  if (settingsInput && settingsInput.trim()) {
    console.log(`Processing settings input...`);
    let inputSettings: DroidSettings = {};

    try {
      inputSettings = JSON.parse(settingsInput);
      console.log(`Parsed settings input as JSON`);
    } catch {
      console.log(
        `Settings input is not inline JSON; reading it as a file path`,
      );
      try {
        const fileContent = await readFile(settingsInput, "utf-8");
        inputSettings = JSON.parse(fileContent);
        console.log(`Successfully read and parsed settings file`);
      } catch (fileError) {
        console.error(`Failed to read or parse settings file`);
        throw new Error(`Failed to process settings input`, {
          cause: fileError,
        });
      }
    }

    settings = { ...settings, ...inputSettings };
    console.log(`Merged settings with input settings`);
  }

  if (process.env.DROID_SAFE_REVIEW_MODE === "true") {
    settings = applyRestrictedReviewSettings(settings, {
      home,
      settingsPath,
      workspace: process.env.GITHUB_WORKSPACE,
      promptFile: process.env.INPUT_PROMPT_FILE,
    });
    console.log(`Applied restricted automatic-review settings`);
  } else {
    settings.enableAllProjectMcpServers = true;
    console.log(`Updated settings with enableAllProjectMcpServers: true`);
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`Settings saved successfully`);
}
