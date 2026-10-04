import { describe, expect, it } from "vitest";
import { isPayflowWorker } from "@/server/dev/processes";

const ROOT = "D:\\Payflow";

describe("worker:stop only matches this checkout's worker", () => {
  it("matches the tsx and node processes of a PayFlow worker", () => {
    expect(isPayflowWorker(`node "D:\\Payflow\\node_modules\\.bin\\..\\.pnpm\\tsx@4.23.15\\node_modules\\tsx\\dist\\cli.mjs" src/worker/index.ts`, ROOT)).toBe(true);
    expect(isPayflowWorker(`D:\\node.exe --require D:\\Payflow\\node_modules\\.pnpm\\tsx@4.23.15\\node_modules\\tsx\\dist\\preflight.cjs --import file:///D:/Payflow/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs src/worker/index.ts`, ROOT)).toBe(true);
  });

  it("never matches anything else", () => {
    // Another project's worker with the same entry file name.
    expect(isPayflowWorker(`node "D:\\OtherApp\\node_modules\\tsx\\dist\\cli.mjs" src/worker/index.ts`, ROOT)).toBe(false);
    // A look-alike folder.
    expect(isPayflowWorker(`node "D:\\Payflow2\\node_modules\\tsx\\dist\\cli.mjs" src/worker/index.ts`, ROOT)).toBe(false);
    // PayFlow's own dev server, the pnpm wrapper, and this control script.
    expect(isPayflowWorker(`node "D:\\Payflow\\node_modules\\next\\dist\\bin\\next" dev`, ROOT)).toBe(false);
    expect(isPayflowWorker(`"node" "C:\\Users\\Admin\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.mjs" -s worker`, ROOT)).toBe(false);
    expect(isPayflowWorker(`node "D:\\Payflow\\node_modules\\tsx\\dist\\cli.mjs" scripts/worker-control.ts stop src/worker/index.ts`, ROOT)).toBe(false);
  });
});
