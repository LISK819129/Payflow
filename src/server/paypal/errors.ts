/**
 * Every failure talking to PayPal surfaces as one of these. The runtime treats
 * any of them as "stop and show the failure"; nothing downstream converts a
 * PayPal error into a success.
 */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    /** PayPal's `name` (e.g. INVALID_REQUEST) or one of ours (NOT_CONFIGURED, NETWORK, MALFORMED_RESPONSE). */
    readonly code: string,
    message: string,
    readonly debugId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }

  /** Safe for logs and the audit trail: no tokens, no request bodies. */
  toJSON() {
    return { status: this.status, code: this.code, message: this.message, debugId: this.debugId, details: this.details };
  }
}

export class PayPalNotConfiguredError extends PayPalApiError {
  constructor(missing: string[]) {
    super(0, "NOT_CONFIGURED", `PayPal is not configured: missing ${missing.join(", ")}`);
  }
}
