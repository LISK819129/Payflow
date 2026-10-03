/**
 * Evidence capture: drives the real PayFlow UI in the locally installed Microsoft
 * Edge (playwright-core, no browser download, no recording software) and saves
 * 1920×1080 screenshots at each step into evidence/phase4/<scenario>/.
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
const OUT = path.resolve("evidence/phase4");

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

async function activate(workflowId: string) {
  const shot = shooter("e2e");
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

async function approve(runId: string) {
  const shot = shooter("e2e");
  const { browser, page } = await open();
  try {
    await page.goto(`${BASE}/executions/${runId}`);
    await page.waitForSelector("section[aria-labelledby=approval-h]");
    await page.waitForTimeout(1500);
    await shot(page, "paused-awaiting-approval", true);
    await page.locator("section[aria-labelledby=approval-h] input").fill("Checked with the client: legitimate larger payment");
    await page.getByRole("button", { name: /^Approve/ }).click();
    await page.waitForSelector("section[aria-labelledby=approval-h]", { state: "detached" });
    // The worker resumes the run; poll the page until it reports completion.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      await page.reload();
      if (await page.getByText("completed", { exact: true }).count()) break;
    }
    await page.waitForTimeout(1500);
    await shot(page, "resumed-and-completed", true);
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
      return activate(a);
    case "run":
      return capture(`/executions/${a}`, "e2e", b ?? "execution");
    case "approve":
      return approve(a);
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
