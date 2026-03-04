import { existsSync, readFileSync, writeFileSync } from "fs";
import { getCursorMcpConfigPath, MCP_SERVER_ID, PROVIDER_ID, OPENCLAW_CONFIG_PATH } from "./constants.js";

export type CleanupResult = {
  mcpRemoved: boolean;
  providerRemoved: boolean;
  modelReset: boolean;
  errors: string[];
};

function cleanupMcpJson(): { removed: boolean; error?: string } {
  const mcpPath = getCursorMcpConfigPath();
  try {
    if (!existsSync(mcpPath)) return { removed: false };

    const raw = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const servers = raw?.mcpServers;
    if (!servers || !servers[MCP_SERVER_ID]) return { removed: false };

    delete servers[MCP_SERVER_ID];
    writeFileSync(mcpPath, JSON.stringify(raw, null, 2) + "\n");
    return { removed: true };
  } catch (e: any) {
    return { removed: false, error: e.message };
  }
}

function cleanupOpenClawConfigFile(): {
  providerRemoved: boolean;
  modelReset: boolean;
  error?: string;
} {
  try {
    if (!existsSync(OPENCLAW_CONFIG_PATH)) {
      return { providerRemoved: false, modelReset: false };
    }

    const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    let changed = false;
    let providerRemoved = false;
    let modelReset = false;

    const defaults = raw?.agents?.defaults;
    const prefix = `${PROVIDER_ID}/`;

    if (defaults?.model) {
      if ((defaults.model.primary as string)?.startsWith(prefix)) {
        delete defaults.model.primary;
        modelReset = true;
        changed = true;
      }
      if (defaults.model.fallbacks) {
        const cleaned = defaults.model.fallbacks.filter(
          (f: string) => !f.startsWith(prefix),
        );
        if (cleaned.length !== defaults.model.fallbacks.length) {
          defaults.model.fallbacks = cleaned.length ? cleaned : undefined;
          modelReset = true;
          changed = true;
        }
      }
      if (!defaults.model.primary && !defaults.model.fallbacks) {
        delete defaults.model;
      }
    }

    if (raw.models?.providers?.[PROVIDER_ID]) {
      delete raw.models.providers[PROVIDER_ID];
      if (!Object.keys(raw.models.providers).length) delete raw.models.providers;
      providerRemoved = true;
      changed = true;
    }

    if (changed) {
      writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
    }

    return { providerRemoved, modelReset };
  } catch (e: any) {
    return { providerRemoved: false, modelReset: false, error: e.message };
  }
}

export function runCleanup(): CleanupResult {
  const result: CleanupResult = {
    mcpRemoved: false,
    providerRemoved: false,
    modelReset: false,
    errors: [],
  };

  const mcpResult = cleanupMcpJson();
  result.mcpRemoved = mcpResult.removed;
  if (mcpResult.error) result.errors.push(`MCP cleanup: ${mcpResult.error}`);

  const configResult = cleanupOpenClawConfigFile();
  result.providerRemoved = configResult.providerRemoved;
  result.modelReset = configResult.modelReset;
  if (configResult.error) result.errors.push(`Config cleanup: ${configResult.error}`);

  return result;
}
