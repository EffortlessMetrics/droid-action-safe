import { homedir } from "os";
import { mkdir, readFile, writeFile } from "fs/promises";

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

  let settings: Record<string, unknown> = {};
  try {
    const existingSettings = await readFile(settingsPath, "utf8");
    if (existingSettings.trim()) {
      settings = JSON.parse(existingSettings);
      // Never serialize settings back into public CI logs: callers commonly
      // supply custom-model credentials and this function runs again for the
      // validator pass.
      console.log(`Found existing Droid settings file`);
    } else {
      console.log(`Settings file exists but is empty`);
    }
  } catch {
    console.log(`No existing settings file found, creating new one`);
  }

  // Handle settings input (either file path or JSON string).
  if (settingsInput && settingsInput.trim()) {
    console.log(`Processing settings input...`);
    let inputSettings: Record<string, unknown> = {};

    try {
      inputSettings = JSON.parse(settingsInput);
      console.log(`Parsed settings input as JSON`);
    } catch {
      // Do not print the value here. A malformed JSON string can itself contain
      // credential material, while a file path is not needed for diagnosis.
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

  // Preserve the existing general-action behavior. Automatic review hardening
  // owns any stricter project-MCP policy separately.
  settings.enableAllProjectMcpServers = true;
  console.log(`Updated settings with enableAllProjectMcpServers: true`);

  // Write directly rather than embedding JSON (which may contain secrets or
  // shell metacharacters) into a shell command. Restrictive permissions also
  // keep other local users from reading service-account/BYOK material.
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`Settings saved successfully`);
}
