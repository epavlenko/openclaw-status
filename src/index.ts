/**
 * OpenClaw Status Plugin — entry point.
 *
 * Registers Status as a channel plugin so OpenClaw can send/receive messages
 * in Status communities automatically via the standard messaging pipeline.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { statusPlugin } from "./channel.js";
import { setStatusRuntime } from "./runtime.js";

const plugin = {
  id: "openclaw-status",
  name: "Status Communities",
  description:
    "Send and receive messages privately in Status communities via Logos messaging (Waku protocol)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setStatusRuntime(api.runtime);
    api.registerChannel({ plugin: statusPlugin });
  },
};

export default plugin;
