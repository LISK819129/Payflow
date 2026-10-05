import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Execution mode, carried with the async call chain.
 *
 * LIVE is the absence of a sandbox. TEST (a person's hypothetical input) and
 * OBSERVE (a real PayPal event evaluated by a draft) run inside `withSandbox`.
 * There is deliberately no way to enter LIVE from inside a sandbox: code that
 * runs within it can never obtain the capability to write to PayPal, and the
 * lowest PayPal layers refuse writes while a sandbox is active.
 */

export type SandboxMode = "TEST" | "OBSERVE";
type Store = { mode: SandboxMode; simulationId: string };

const als = new AsyncLocalStorage<Store>();

export function withSandbox<T>(mode: SandboxMode, simulationId: string, fn: () => Promise<T>): Promise<T> {
  if (mode !== "TEST" && mode !== "OBSERVE") throw new Error(`Unknown sandbox mode ${String(mode)}`);
  return als.run({ mode, simulationId }, fn);
}

export function currentMode(): "LIVE" | SandboxMode {
  return als.getStore()?.mode ?? "LIVE";
}

export class SandboxWriteBlocked extends Error {
  constructor(what: string) {
    super(`${what} refused: this is a ${currentMode()} execution, which has no PayPal write capability`);
    this.name = "SandboxWriteBlocked";
  }
}

/** Last line of defence at every PayPal write path. */
export function assertLiveWrite(what: string) {
  if (currentMode() !== "LIVE") throw new SandboxWriteBlocked(what);
}
