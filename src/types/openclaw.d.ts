/**
 * Minimal type stubs for openclaw/plugin-sdk/core.
 * These are provided at runtime by the OpenClaw host.
 */
declare module "openclaw/plugin-sdk/core" {
  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime: any;
    registerChannel: (registration: { plugin: unknown }) => void;
    registerTool: (tool: unknown) => void;
  }

  export function emptyPluginConfigSchema(): {
    type: "object";
    additionalProperties: false;
    properties: Record<string, never>;
  };
}
