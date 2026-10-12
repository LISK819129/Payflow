import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCKED_VENDOR, CLOUD_SCOPE, cloudGraph } from "@/server/demo/setup";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { effectivePermission, summarizeRule, type AuthorityTerms } from "@/server/workflow/rule-summary";

/** The Flow Builder's "This rule" summary: workflow vs authority, in words. Descriptive only — it must never overstate what can be paid. */
const COMPILED = (JSON.parse(readFileSync("tests/fixtures/real-openai/manual-payout-200-graph.json", "utf8")) as { graph: WorkflowGraph }).graph;
const ACME = "sb-yluat53193698@personal.example.com";
const AWS = "sb-mnylb53193692@personal.example.com";

const authority = (o: Partial<AuthorityTerms> = {}): AuthorityTerms => ({
  id: "a1",
  name: "Cloud procurement",
  version: 1,
  actions: ["paypal.payout"],
  counterpartyRule: "allowlist",
  counterparties: [
    { id: ACME, name: "Acme Cloud" },
    { id: AWS, name: "AWS" },
  ],
  denied: [{ id: BLOCKED_VENDOR, name: "Blocked Vendor" }],
  currencies: ["USD"],
  perTransactionMax: "500.00",
  budgetAmount: "5000.00",
  budgetPeriod: "month",
  purposeScope: CLOUD_SCOPE,
  expiresAt: null,
  ...o,
});

describe("This rule — workflow vs authority", () => {
  it("reads a compiled manual payout rule the way a person would describe it", () => {
    const r = summarizeRule(COMPILED);
    expect(r).toMatchObject({ source: "manual", movesMoney: true, actions: ["paypal.payout"], suppliers: [ACME, AWS], currencies: ["USD"], hasApprovalStep: true });
    expect(r.amountGate).toEqual({ max: { value: "200.00", currency: "USD" }, comparison: "lte", above: "approval" });
  });

  it("with no authority, nothing is paid without a person", () => {
    expect(effectivePermission(summarizeRule(COMPILED), []).covered).toBe(false);
    // An authority for another action does not count.
    expect(effectivePermission(summarizeRule(COMPILED), [authority({ actions: ["paypal.refund"] })]).covered).toBe(false);
  });

  it("the stricter limit applies, and says where it comes from", () => {
    const rule = summarizeRule(COMPILED);
    expect(effectivePermission(rule, [authority()])).toMatchObject({ covered: true, autoMax: { value: "200.00" }, autoMaxFrom: "workflow", currencies: ["USD"], purpose: CLOUD_SCOPE, budget: "$5,000 a month" });
    expect(effectivePermission(rule, [authority({ perTransactionMax: "150" })])).toMatchObject({ autoMax: { value: "150" }, autoMaxFrom: "authority" });
    expect(effectivePermission(rule, [authority({ perTransactionMax: "200.00" })]).autoMaxFrom).toBe("both");
    // Several authorities: every one must allow — the smallest maximum wins.
    expect(effectivePermission(rule, [authority(), authority({ id: "a2", perTransactionMax: "120" })]).autoMax?.value).toBe("120");
  });

  it("recipients: only those both allow; names the ones outside the authority; shows the deny list", () => {
    const e = effectivePermission(summarizeRule(COMPILED), [authority({ counterparties: [{ id: ACME, name: "Acme Cloud" }] })]);
    expect(e.suppliers.list).toEqual([{ id: ACME, name: "Acme Cloud" }]);
    expect(e.suppliers.outsideAuthority).toEqual([AWS]);
    expect(e.suppliers.denied).toEqual(["Blocked Vendor"]);
  });

  it("the demo agent workflow: requests come from agents, the authority sets the ceiling", () => {
    const r = summarizeRule(cloudGraph());
    expect(r.source).toBe("agent");
    expect(r.amountGate).toBeNull();
    const e = effectivePermission(r, [authority()]);
    expect(e).toMatchObject({ autoMax: { value: "500.00" }, autoMaxFrom: "authority", currencies: ["USD"] });
    expect(e.suppliers.list).toEqual([
      { id: ACME, name: "Acme Cloud" },
      { id: AWS, name: "AWS" },
    ]);
  });

  it("flags an agent workflow that reads fields agent requests never carry", () => {
    expect(summarizeRule(cloudGraph()).unknownAgentFields).toEqual([]);
    // The real compiler output that motivated this: recipient read from trigger.receiver, but agents send trigger.counterparty.
    const g = JSON.parse(JSON.stringify(cloudGraph()).replaceAll("trigger.counterparty", "trigger.receiver")) as WorkflowGraph;
    expect(summarizeRule(g).unknownAgentFields).toEqual(["receiver"]);
    // Manual workflows may read any field the person types.
    expect(summarizeRule(COMPILED).unknownAgentFields).toEqual([]);
  });

  it("says so when the workflow's purpose wording differs from the authority's (every payment would wait for a person)", () => {
    // A compiled rule that checks purpose against its own words, as the compiler writes it.
    const g = JSON.parse(JSON.stringify(cloudGraph())) as WorkflowGraph;
    (g.nodes.find((n) => n.type === "ai.purpose_classification")!.config as { scope?: string }).scope = "cloud infrastructure";
    const rule = summarizeRule(g);
    expect(rule.purposeScopes).toEqual(["cloud infrastructure"]);
    expect(effectivePermission(rule, [authority()]).purposeMismatch).toEqual({ workflow: "cloud infrastructure", authority: CLOUD_SCOPE });
    // Identical wording, or no wording on the step (it then uses the authority's): no mismatch.
    expect(effectivePermission(rule, [authority({ purposeScope: "cloud infrastructure" })]).purposeMismatch).toBeNull();
    expect(effectivePermission(summarizeRule(cloudGraph()), [authority()]).purposeMismatch).toBeNull();
    // An authority with no purpose does not require one.
    expect(effectivePermission(rule, [authority({ purposeScope: null })]).purposeMismatch).toBeNull();
  });
});
