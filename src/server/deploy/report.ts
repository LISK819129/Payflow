/** A small PASS / WARN / FAIL report for the deploy commands. Never prints secrets. */
export type Status = "PASS" | "WARN" | "FAIL" | "INFO";
export type Check = { name: string; status: Status; detail: string; fix?: string };

export class Report {
  readonly checks: Check[] = [];
  add(name: string, status: Status, detail: string, fix?: string) {
    this.checks.push({ name, status, detail, fix });
    const mark = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL", INFO: "    " }[status];
    console.log(`${mark}  ${name} — ${detail}${fix ? `\n      → ${fix}` : ""}`);
    return status;
  }
  get failed() {
    return this.checks.filter((c) => c.status === "FAIL").length;
  }
  get warned() {
    return this.checks.filter((c) => c.status === "WARN").length;
  }
  summary(title: string) {
    const ok = this.checks.filter((c) => c.status === "PASS").length;
    console.log(`\n${title}: ${ok} passed, ${this.warned} warning(s), ${this.failed} failed`);
    return this.failed === 0;
  }
}

/** Runs one check; an exception becomes a FAIL with its message (never a stack trace). */
export async function step(report: Report, name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    report.add(name, "FAIL", (e as Error).message.split("\n")[0].slice(0, 300));
  }
}
