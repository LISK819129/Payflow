import type { StatusTone } from "@/components/ui";

export const runTone: Record<string, StatusTone> = {
  RUNNING: "live",
  WAITING_APPROVAL: "warn",
  WAITING_TIMER: "neutral",
  SUSPENDED: "warn",
  COMPLETED: "ok",
  BLOCKED: "danger",
  REJECTED: "danger",
  NEEDS_REVIEW: "warn",
  FAILED: "danger",
};

export const runLabel = (s: string) => s.toLowerCase().replace("_", " ");
