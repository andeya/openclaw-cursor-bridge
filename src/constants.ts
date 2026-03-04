import { homedir } from "os";
import { join } from "path";

export const PLUGIN_ID = "cursor-brain";
export const MCP_SERVER_ID = "openclaw-gateway";
export const CLI_BACKEND_ID = "cursor-cli";

const IS_WIN = process.platform === "win32";

export const OPENCLAW_HOME = join(homedir(), ".openclaw");
export const OPENCLAW_CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");

export function getCursorMcpConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

export function getCursorSearchPaths(): string[] {
  const home = homedir();
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "Programs", "cursor", "resources", "app", "bin", "agent.exe"),
      join(home, ".cursor", "bin", "agent.exe"),
      join(home, ".local", "bin", "agent.exe"),
    ];
  }
  return [
    join(home, ".local", "bin", "agent"),
    "/usr/local/bin/agent",
    join(home, ".cursor", "bin", "agent"),
  ];
}

export function getWhichCommand(): string {
  return IS_WIN ? "where agent 2>nul" : "which agent 2>/dev/null";
}

export function buildShellArgs(cursorPath: string, workspaceDir: string): {
  command: string;
  args: string[];
} {
  const flags = ["-p", "--output-format", "json", "--trust", "--approve-mcps", "--force"];
  if (IS_WIN) {
    const batchCmd = `cd /d "${workspaceDir}" && "${cursorPath}" ${flags.join(" ")}`;
    return {
      command: "cmd.exe",
      args: ["/c", batchCmd],
    };
  }
  const bashCmd = `export SHELL=/bin/bash && cd ${workspaceDir} && exec ${cursorPath} "$@"`;
  return {
    command: "/bin/bash",
    args: ["-c", bashCmd, "_", ...flags],
  };
}

export const CLI_BACKEND_COMMON = {
  output: "json" as const,
  input: "arg" as const,
  modelArg: "--model",
  sessionArg: "--resume",
  sessionMode: "existing" as const,
};
