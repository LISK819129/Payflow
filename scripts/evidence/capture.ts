/**
 * Evidence capture: drives the real PayFlow UI in the locally installed Microsoft
 * Edge (playwright-core, no browser download, no recording software) and saves
 * 1920×1080 screenshots at each step into evidence/<phase>/<scenario>/
 * (EVIDENCE_PHASE, default phase4).
 *
 *   pnpm evidence <step> [args]
 *     compile <scenarioKey>                  natural language → graph (real AI call via the UI)
 *     replay <compilationId> <scenario>      re-render a stored real compilation (no model call)
 *     answer <compilationId> <scenario> "a||b||c"  answer its questions and compile again (real AI call)
 *     activate <workflowId>                  owner clicks Activate in the Flow Builder
 *     run <runId> <label>                    capture an execution page
 *     approve <runId>                        owner approves the waiting run in the UI
 *     edit <workflowId> <scenarioKey> [keep] AI edit in the Flow Builder (real AI call)
 *     page <path> <scenario> <label>         capture any page (audit, events, settings…)
 *     manual <workflowId> <scenario> <json> [double]  owner starts a manual run in the UI
 *                                            (double: clicks Start twice) and waits for it to settle
 *     approve <runId> [scenario] [note]       as above, into a named scenario
 *     authority <scenario> <json>            owner creates an authority in the Authority form
 *
 * Credentials are the seeded local test owner from .env.local; the browser only
 * talks to localhost. Screenshots never include env files or secrets.
 */
import "../load-env";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { spentUsd } from "../../src/server/ai/usage";
import { closeDb } from "../../src/server/db/client";
import { PHASE4_STOP_USD, SCENARIOS, type ScenarioKey } from "./scenarios";

const BASE = "http://localhost:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = path.resolve("evidence", process.env.EVIDENCE_PHASE ?? "phase4");

async function guardBudget() {
  const spent = Number(await spentUsd());
  if (spent >= PHASE4_STOP_USD) throw new Error(`Phase 4 AI spend is $${spent.toFixed(4)} (stop at $${PHASE4_STOP_USD}); not making another call`);
  return spent;
}

async function open() {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  await page.goto(`${BASE}/login`);
  await page.fill("#email", process.env.SEED_OWNER_EMAIL!);
  await page.fill("#password", process.env.SEED_OWNER_PASSWORD!);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click("button[type=submit]")]);
  return { browser, page };
}

/** Hides the Next.js dev badge so evidence shows only the product. */
async function clean(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }" }).catch(() => {});
}

function shooter(scenario: string) {
  const dir = path.join(OUT, scenario);
  mkdirSync(dir, { recursive: true });
  // Continue numbering after any earlier captures of the same scenario.
  let n = readdirSync(dir).filter((f) => f.endsWith(".png")).length;
  return async (page: Page, label: string, fullPage = false) => {
    await clean(page);
    n += 1;
    const file = path.join(dir, `${String(n).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file, fullPage });
    console.log(`  saved ${path.relative(process.cwd(), file)}`);
    return file;
  };
}

async function compile(key: ScenarioKey) {
  const before = await guardBudget();
  const shot = shooter(`${key}`);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows`);
    const box = page.getByLabel("Describe a financial workflow");
    await box.fill(SCENARIOS[key]);
    await shot(page, "instruction");
    await page.getByRole("button", { name: "Generate" }).click();
    await page.waitForTimeout(1200);
    await shot(page, "compiling");
    // PayFlow's own result elements only (Next's route announcer also has role=alert, outside <main>).
    await page.waitForSelector('main section[aria-label="PayFlow validation"], main p[role="alert"]', { timeout: 300_000 });
    await shot(page, "validated");
    await page.waitForTimeout(4500); // let the graph finish revealing
    await shot(page, "ready", true);
    const open = page.getByRole("link", { name: "Open draft in Flow Builder" });
    if (await open.count()) {
      await Promise.all([page.waitForURL(/\/flows\/[0-9a-f-]{36}$/), open.click()]);
      await page.waitForSelector("header h1");
      await page.waitForSelector(".react-flow__node");
      await page.waitForTimeout(1500);
      await shot(page, "draft-in-flow-builder");
      console.log(`  workflow: ${page.url().split("/").pop()}`);
    }
  } finally {
    await browser.close();
    console.log(`  AI spend this step: $${(Number(await spentUsd()) - before).toFixed(6)}`);
  }
}

/** Answers a stored clarification through the UI and compiles again (one real AI call). */
async function answer(compilationId: string, scenario: string, answers: string[]) {
  const before = await guardBudget();
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows?compilation=${compilationId}`);
    await page.waitForSelector('main section[aria-label="PayFlow validation"]');
    const inputs = page.getByRole("group", { name: "Answer the questions" }).locator("input");
    const n = await inputs.count();
    for (let i = 0; i < Math.min(n, answers.length); i++) await inputs.nth(i).fill(answers[i]);
    await page.waitForTimeout(500);
    await shot(page, "clarification-answered", true);
    await page.getByRole("button", { name: "Compile again with these answers" }).click();
    await page.waitForTimeout(1500);
    await shot(page, "recompiling");
    await page.waitForFunction(() => !document.querySelector("main")?.textContent?.includes("Compiling…"), null, { timeout: 400_000 });
    await page.waitForSelector('main section[aria-label="PayFlow validation"], main p[role="alert"]');
    await page.waitForTimeout(5000);
    await shot(page, "ready", true);
    const link = page.getByRole("link", { name: "Open draft in Flow Builder" });
    if (await link.count()) {
      await Promise.all([page.waitForURL(/\/flows\/[0-9a-f-]{36}$/), link.click()]);
      await page.waitForSelector("header h1");
      await page.waitForSelector(".react-flow__node");
      await page.waitForTimeout(1500);
      await shot(page, "draft-in-flow-builder");
    }
  } finally {
    await browser.close();
    console.log(`  AI spend this step: $${(Number(await spentUsd()) - before).toFixed(6)}`);
  }
}

/** Re-renders a stored real compilation (no model call) and captures the result and its draft. */
async function replay(compilationId: string, scenario: string) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows?compilation=${compilationId}`);
    await page.waitForSelector('main section[aria-label="PayFlow validation"]');
    await page.waitForTimeout(4500);
    await shot(page, "stored-result", true);
    const link = page.getByRole("link", { name: "Open draft in Flow Builder" });
    if (await link.count()) {
      await Promise.all([page.waitForURL(/\/flows\/[0-9a-f-]{36}$/), link.click()]);
      await page.waitForSelector("header h1");
      await page.waitForSelector(".react-flow__node");
      await page.waitForTimeout(1500);
      await shot(page, "draft-in-flow-builder");
    }
  } finally {
    await browser.close();
  }
}

async function activate(workflowId: string, scenario = "e2e") {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows/${workflowId}`);
    await page.waitForSelector(".react-flow__node");
    await page.waitForTimeout(1200);
    await shot(page, "draft-before-activation");
    await page.getByRole("button", { name: /Activate v\d+/ }).click();
    await page.getByRole("status").filter({ hasText: "is active" }).waitFor();
    await page.waitForTimeout(800);
    await shot(page, "activated-by-owner");
  } finally {
    await browser.close();
  }
}

async function capture(urlPath: string, scenario: string, label: string, full = true) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/${urlPath.replace(/^\/+/, "")}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1800);
    await shot(page, label, full);
  } finally {
    await browser.close();
  }
}

async function approve(runId: string, scenario = "e2e", note = "Checked with the client: legitimate larger payment", decision: "approve" | "reject" = "approve") {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    // The decision is made from the Approvals queue, where the full context is shown.
    await page.goto(`${BASE}/approvals`);
    const card = page.locator("article").filter({ has: page.locator(`a[href="/executions/${runId}"]`) });
    await card.waitFor();
    await page.waitForTimeout(1200);
    await shot(page, "approvals-queue", true);
    await card.getByLabel(/^Note/).fill(note);
    await card.getByRole("button", { name: decision === "approve" ? /^Approve once/ : /^Reject$/ }).click();
    await card.waitFor({ state: "detached" });
    await page.goto(`${BASE}/executions/${runId}`);
    // The worker resumes the run; poll until it settles.
    for (let i = 0; i < 25; i++) {
      const status = await page.locator("[data-run-status]").first().getAttribute("data-run-status");
      if (status && !["RUNNING", "WAITING_APPROVAL", "WAITING_TIMER"].includes(status)) break;
      await page.waitForTimeout(1500);
      await page.reload();
    }
    await page.waitForTimeout(1500);
    await shot(page, decision === "approve" ? "approved-once-and-executed" : "rejected-paypal-not-contacted", true);
    await page.goto(`${BASE}/approvals`);
    await page.waitForTimeout(1200);
    await shot(page, "approvals-decided", true);
  } finally {
    await browser.close();
  }
}

/** Two tabs of the same owner click "Approve once" at the same moment: one decision, one PayPal action. */
async function approveTwice(runId: string, scenario: string) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    const other = await page.context().newPage();
    for (const p of [page, other]) {
      await p.goto(`${BASE}/approvals`);
      await p.locator("article").filter({ has: p.locator(`a[href="/executions/${runId}"]`) }).waitFor();
    }
    await shot(page, "same-approval-open-in-two-tabs", true);
    const click = (p: Page) => p.locator("article").filter({ has: p.locator(`a[href="/executions/${runId}"]`) }).getByRole("button", { name: /^Approve once/ }).click();
    await Promise.all([click(page), click(other)]);
    await page.waitForTimeout(2500);
    await other.waitForTimeout(500);
    await shot(other, "second-tab-after-click", true);
    await page.goto(`${BASE}/executions/${runId}`);
    for (let i = 0; i < 25; i++) {
      const status = await page.locator("[data-run-status]").first().getAttribute("data-run-status");
      if (status && !["RUNNING", "WAITING_APPROVAL", "WAITING_TIMER"].includes(status)) break;
      await page.waitForTimeout(1500);
      await page.reload();
    }
    await page.waitForTimeout(1500);
    await shot(page, "one-payout", true);
  } finally {
    await browser.close();
  }
}

/** Waits until the run page shows a settled status, reloading as the worker advances it. */
async function settle(page: Page) {
  for (let i = 0; i < 40; i++) {
    const status = await page.locator("[data-run-status]").first().getAttribute("data-run-status");
    if (status && status !== "RUNNING" && status !== "WAITING_TIMER") return;
    await page.waitForTimeout(1500);
    await page.reload();
  }
}

async function manual(workflowId: string, scenario: string, payload: string, double: boolean) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows/${workflowId}`);
    await page.waitForSelector(".react-flow__node");
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Run manually" }).click();
    await page.getByLabel("Run payload (JSON)").fill(JSON.stringify(JSON.parse(payload), null, 2));
    await shot(page, "manual-run-payload");
    const start = page.getByRole("button", { name: "Start run" });
    if (double) {
      // Two submissions of the same dialog, as a double click or a retried request would send.
      await start.evaluate((b: HTMLButtonElement) => {
        b.click();
        b.removeAttribute("disabled");
        b.click();
      });
    } else await start.click();
    await page.waitForURL(/\/executions\//);
    const runId = page.url().split("/").pop();
    console.log(`  run ${runId}`);
    await page.waitForTimeout(1500);
    await settle(page);
    await page.waitForTimeout(1500);
    await shot(page, "run-settled", true);
  } finally {
    await browser.close();
  }
}

/** Owner edits an authority's allowlist in the Edit form (saved as a new, audited version). */
async function editAuthorityAllowlist(scenario: string, name: string, allow: string) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/authority`);
    const card = page.getByRole("article", { name: `Authority ${name}` });
    await Promise.all([page.waitForURL(/\/authority\/.+\/edit$/), card.getByRole("link", { name: "Edit" }).click()]);
    await page.getByLabel(/^Allowed — one per line/).fill(allow.replaceAll(";", "\n"));
    await shot(page, "edit-allowlist", true);
    await Promise.all([page.waitForURL(`${BASE}/authority`), page.getByRole("button", { name: "Save as a new version" }).click()]);
    await page.waitForTimeout(1500);
    await shot(page, "authority-v2", true);
  } finally {
    await browser.close();
  }
}

/** Owner adds a purpose scope and AI-evidence policy to an authority in the Edit form (new audited version). */
async function editAuthorityPurpose(scenario: string, name: string, scope: string, policyJson: string) {
  const policy = JSON.parse(policyJson) as Record<string, "allow" | "review" | "deny">;
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/authority`);
    const card = page.getByRole("article", { name: `Authority ${name}` });
    await Promise.all([page.waitForURL(/\/authority\/.+\/edit$/), card.getByRole("link", { name: "Edit" }).click()]);
    await page.getByLabel(/^For what/).fill(scope);
    const labels: Record<string, string> = { purposeOutside: "AI says outside the purpose", riskElevated: "Elevated risk signals", riskHigh: "High risk signals", contractMismatch: "Invoice differs from contract", injection: "Document tries to instruct the AI" };
    for (const [k, v] of Object.entries(policy)) await page.getByRole("combobox", { name: labels[k] }).selectOption(v);
    await shot(page, "purpose-and-ai-policy", true);
    await Promise.all([page.waitForURL(`${BASE}/authority`), page.getByRole("button", { name: "Save as a new version" }).click()]);
    await page.waitForTimeout(1500);
    await shot(page, "authority-with-purpose", true);
  } finally {
    await browser.close();
  }
}

/** Owner changes an authority's monthly budget in the Edit form (new audited version). */
async function editAuthorityBudget(scenario: string, name: string, amount: string) {
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/authority`);
    const card = page.getByRole("article", { name: `Authority ${name}` });
    await Promise.all([page.waitForURL(/\/authority\/.+\/edit$/), card.getByRole("link", { name: "Edit" }).click()]);
    await page.getByLabel(/^Budget/).fill(amount);
    await shot(page, "edit-budget", true);
    await Promise.all([page.waitForURL(`${BASE}/authority`), page.getByRole("button", { name: "Save as a new version" }).click()]);
    await page.waitForTimeout(1500);
    await shot(page, "authority-new-budget", true);
  } finally {
    await browser.close();
  }
}

/** Owner creates a delegated authority through the Authority form. */
async function newAuthority(scenario: string, spec: string) {
  const v = JSON.parse(spec) as { name: string; workflow: string; actions: string[]; allow: string; deny?: string; perTx?: string; budget?: string; period?: string; expires?: string };
  const shot = shooter(scenario);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/authority/new`);
    await page.getByLabel("Name", { exact: true }).fill(v.name);
    await page.getByLabel(v.workflow, { exact: true }).check();
    for (const a of v.actions) await page.getByLabel(a, { exact: true }).check();
    await page.getByLabel(/^Allowed — one per line/).fill(v.allow.replaceAll(";", "\n"));
    if (v.deny) await page.getByLabel(/^Never pay/).fill(v.deny.replaceAll(";", "\n"));
    if (v.perTx) await page.getByLabel(/^Per transaction/).fill(v.perTx);
    if (v.budget) {
      await page.getByLabel(/^Budget/).fill(v.budget);
      await page.getByRole("combobox").first().selectOption(v.period ?? "month");
    }
    if (v.expires) await page.getByLabel(/^Expires/).fill(v.expires);
    await shot(page, "new-authority-form", true);
    await Promise.all([page.waitForURL(`${BASE}/authority`), page.getByRole("button", { name: "Create authority" }).click()]);
    await page.waitForTimeout(1500);
    await shot(page, "authority-created", true);
  } finally {
    await browser.close();
  }
}

async function edit(workflowId: string, key: ScenarioKey, keep: boolean) {
  const before = await guardBudget();
  const shot = shooter(`edit-${key}`);
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/flows/${workflowId}`);
    await page.waitForSelector(".react-flow__node");
    await page.waitForTimeout(1200);
    await shot(page, "before");
    await page.fill("#pf-command", SCENARIOS[key]);
    await page.getByRole("button", { name: "Propose change" }).click();
    await page.waitForTimeout(1200);
    await shot(page, "working");
    await page.waitForSelector('[role="region"][aria-label="Proposed change"]');
    await page.waitForTimeout(2500);
    await shot(page, "proposal-diff");
    if (keep && (await page.getByRole("button", { name: "Keep changes" }).isEnabled())) {
      const ack = page.getByLabel("I understand and want this change");
      if (await ack.count()) await ack.check();
      await page.getByRole("button", { name: "Keep changes" }).click();
      await page.waitForSelector('[role="region"][aria-label="Proposed change"]', { state: "detached" });
      await page.waitForTimeout(2000);
      await shot(page, "kept-as-new-draft");
    }
  } finally {
    await browser.close();
    console.log(`  AI spend this step: $${(Number(await spentUsd()) - before).toFixed(6)}`);
  }
}

async function main() {
  const [step, a, b, c] = process.argv.slice(2);
  console.log(`evidence: ${step} ${a ?? ""} ${b ?? ""}`);
  switch (step) {
    case "compile":
      return compile(a as ScenarioKey);
    case "replay":
      return replay(a, b);
    case "answer":
      return answer(a, b, (c ?? "").split("||"));
    case "activate":
      return activate(a, b);
    case "run":
      return capture(`/executions/${a}`, "e2e", b ?? "execution");
    case "approve":
      return approve(a, b, c);
    case "approve-twice":
      return approveTwice(a, b);
    case "reject":
      return approve(a, b, c, "reject");
    case "authority-budget":
      return editAuthorityBudget(a, b, c);
    case "authority-purpose":
      return editAuthorityPurpose(a, b, c, process.argv[6] ?? "{}");
    case "authority-allow":
      return editAuthorityAllowlist(a, b, c);
    case "authority":
      return newAuthority(a, b);
    case "manual":
      return manual(a, b, c, process.argv[6] === "double");
    case "edit":
      return edit(a, b as ScenarioKey, c === "keep");
    case "page":
      return capture(a, b, c);
    default:
      throw new Error(`unknown step ${step}`);
  }
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
