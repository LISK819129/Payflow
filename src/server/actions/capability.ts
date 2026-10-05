import { assertLiveWrite } from "../runtime/mode";
import { gatewayFor } from "./paypal-gateway";
import type { ActionGateway, ActionIntent } from "./types";

/**
 * The capability to send an action to PayPal. It can only be created outside a
 * Test/Observe sandbox, and the action runner refuses anything that was not
 * issued here. Test and Observe executions are never handed one.
 */
export type PayPalWrite = { readonly gatewayFor: (intent: ActionIntent) => ActionGateway };

const issued = new WeakSet<object>();

export function livePayPalWrite(): PayPalWrite {
  assertLiveWrite("Obtaining the PayPal write capability");
  const cap: PayPalWrite = Object.freeze({ gatewayFor });
  issued.add(cap);
  return cap;
}

export function isGenuineWrite(cap: unknown): cap is PayPalWrite {
  return typeof cap === "object" && cap !== null && issued.has(cap);
}
