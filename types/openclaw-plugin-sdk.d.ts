declare module "openclaw/plugin-sdk" {
  export interface PluginLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  }

  export interface OpenClawPluginApi {
    config: Record<string, any>;
    pluginConfig: Record<string, unknown> | undefined;
    logger: PluginLogger;
    runtime: {
      config: {
        writeConfigFile(patch: Record<string, any>): Promise<void>;
      };
    };
    resolvePath(rel: string): string;
    registerCli(
      handler: (ctx: { program: any }) => void,
      opts?: { commands?: string[] },
    ): void;
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;
}
