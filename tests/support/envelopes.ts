import { compiled } from "./mock-ai";

const end = (id: string, outcome = "completed", message = id) => ({ id, type: "control.terminal", config: { outcome, message } });

export function approvalEnvelope() {
  return compiled(
    "Approve large payments",
    [
      { id: "payment", type: "trigger.paypal_event", config: { eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] } },
      { id: "over_400", type: "control.condition", config: { expr: { op: "gt", left: { ref: "trigger.amount" }, right: { const: "400" } } } },
      { id: "ask_me", type: "control.approval", config: { reason: "Payment over $400" } },
      end("accepted"),
      end("rejected", "rejected"),
    ],
    [
      ["payment", "next", "over_400"],
      ["over_400", "false", "accepted"],
      ["over_400", "true", "ask_me"],
      ["ask_me", "approved", "accepted"],
      ["ask_me", "rejected", "rejected"],
    ],
  );
}
