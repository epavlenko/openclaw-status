/**
 * Plugin runtime store — holds the OpenClaw PluginRuntime reference
 * so that channel.ts and other modules can access it without circular imports.
 */

// We use `any` for the runtime type since we don't have the SDK types at compile time.
// At runtime, this is always the full PluginRuntime object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginRuntime = any;

let _runtime: PluginRuntime | null = null;

export function getStatusRuntime(): PluginRuntime {
  if (!_runtime) {
    throw new Error("[openclaw-status] Runtime not initialized — was setStatusRuntime() called?");
  }
  return _runtime;
}

export function setStatusRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}
