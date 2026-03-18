/**
 * OpenClaw Status Plugin — entry point.
 *
 * Registers Status as a channel plugin so OpenClaw can send/receive messages
 * in Status communities automatically via the standard messaging pipeline.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { statusPlugin } from "./channel.js";
import { setStatusRuntime } from "./runtime.js";
import { buildCommunityTool } from "./community-tool.js";

const plugin = {
  id: "openclaw-status",
  name: "Status Communities",
  description:
    "Send and receive messages privately in Status communities via Logos messaging (Waku protocol)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setStatusRuntime(api.runtime);
    api.registerChannel({ plugin: statusPlugin });
    const tool = buildCommunityTool(api.config);
    console.log(`[status] Registering tool: ${tool.name}`);
    try {
      api.registerTool(tool);
      console.log(`[status] Tool ${tool.name} registered successfully`);
    } catch (err) {
      console.error(`[status] Failed to register tool ${tool.name}:`, err);
    }
  },
};

export default plugin;
