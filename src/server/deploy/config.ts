/**
 * The judging deployment, as data. Everything here is an identifier, not a
 * secret: the judge login's email (its password is a Render secret), the two
 * PayPal Sandbox *personal* accounts that receive demo payouts (no passwords
 * are stored anywhere), and the existing Sandbox webhook's id.
 */
export const JUDGE_DEPLOYMENT = {
  ownerEmail: "judge@payflow.demo",
  suppliers: {
    acme: { name: "Acme Cloud", email: "sb-yluat53193698@personal.example.com" },
    aws: { name: "AWS Demo", email: "sb-mnylb53193692@personal.example.com" },
  },
  /** The existing PixelForge Sandbox webhook. Moving it keeps this id. */
  webhookId: "9MJ408823R309725D",
  webhookPath: "/api/webhooks/paypal",
  /** What render.yaml must create — and nothing else. */
  resources: [
    { kind: "database", name: "payflow-db", plan: "0.1c-256mb", monthlyUsd: 6.3 },
    { kind: "web", name: "payflow-web", plan: "0.5c-512mb", monthlyUsd: 7, instances: 1 },
    { kind: "worker", name: "payflow-worker", plan: "0.5c-512mb", monthlyUsd: 7, instances: 1 },
  ],
} as const;

export const EXPECTED_MONTHLY_USD = JUDGE_DEPLOYMENT.resources.reduce((t, r) => t + r.monthlyUsd, 0);
