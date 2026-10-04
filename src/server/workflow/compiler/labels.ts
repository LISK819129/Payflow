import { isDecimal, toScaled } from "../dsl/decimal";
import type { GraphNode, WorkflowGraph } from "../dsl/nodes";

/**
 * Keeps human-readable text consistent with configuration after an edit.
 * When a node's amount changes (2500.00 → 1800.00), every mention of the old
 * amount in that node's own label and wording is rewritten in the same style
 * ("$2,500" → "$1,800"). Mentions in *other* nodes are reported, not changed:
 * they may legitimately refer to the old amount.
 */

export type LabelRefresh = { nodeId: string; field: string; before: string; after: string };
export type StaleMention = { nodeId: string; field: string; text: string; value: string };

const TEXT_FIELDS = ["reason", "message"] as const;

function decimalsIn(value: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (isDecimal(value) || (typeof value === "number" && Number.isFinite(value))) out.set(path, String(value));
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) for (const [p, d] of decimalsIn(v, path ? `${path}.${k}` : k)) out.set(p, d);
  }
  return out;
}

function group(int: string) {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** All the ways a person might have written `value` ("2500.00" → $2,500 / 2,500.00 / 2500 …), longest first. */
function spellings(value: string): string[] {
  const [int, frac = ""] = value.split(".");
  const trimmedFrac = frac.replace(/0+$/, "");
  const bodies = new Set<string>();
  for (const g of [group(int), int]) {
    bodies.add(g);
    if (frac) bodies.add(`${g}.${frac}`);
    if (trimmedFrac) bodies.add(`${g}.${trimmedFrac}`);
    if (!trimmedFrac) bodies.add(`${g}.00`);
  }
  const all = [...bodies].flatMap((b) => [`$${b}`, b]);
  return all.sort((a, b) => b.length - a.length);
}

/** Writes `next` in the same style as the matched old spelling. */
function restyle(matched: string, next: string): string {
  const dollar = matched.startsWith("$");
  const body = dollar ? matched.slice(1) : matched;
  // "$500" can't show whether its writer groups thousands; currency-style text does by default.
  const grouped = body.includes(",") || (dollar && body.split(".")[0].length <= 3);
  const decimals = body.includes(".") ? body.split(".")[1].length : 0;
  const [int, frac = ""] = next.split(".");
  const n = (grouped ? group(int) : int) + (decimals ? `.${(frac + "00").slice(0, decimals)}` : "");
  return (dollar ? "$" : "") + n;
}

function findSpelling(text: string, value: string): { at: number; matched: string } | null {
  for (const s of spellings(value)) {
    const re = new RegExp(`(?<![\\d.,])${s.replace(/[$.,]/g, (c) => `\\${c}`)}(?![\\d]|[.,]\\d)`);
    const m = re.exec(text);
    if (m) return { at: m.index, matched: m[0] };
  }
  return null;
}

function replaceAll(text: string, oldValue: string, newValue: string): string {
  let out = text;
  for (let guard = 0; guard < 10; guard++) {
    const hit = findSpelling(out, oldValue);
    if (!hit) break;
    out = out.slice(0, hit.at) + restyle(hit.matched, newValue) + out.slice(hit.at + hit.matched.length);
  }
  return out;
}

/** Mutates `after`: refreshes stale amounts in changed nodes' own text. */
export function refreshLabels(before: WorkflowGraph, after: WorkflowGraph): { refreshed: LabelRefresh[]; stale: StaleMention[] } {
  const refreshed: LabelRefresh[] = [];
  const stale: StaleMention[] = [];
  const prev = new Map(before.nodes.map((n) => [n.id, n]));
  const changedValues: { nodeId: string; from: string; to: string }[] = [];

  for (const n of after.nodes) {
    const p = prev.get(n.id);
    if (!p) continue;
    const a = decimalsIn(p.config);
    const b = decimalsIn(n.config);
    for (const [path, from] of a) {
      const to = b.get(path);
      if (to === undefined || to === from) continue;
      try {
        if (toScaled(to) === toScaled(from)) continue;
      } catch {
        continue;
      }
      changedValues.push({ nodeId: n.id, from, to });
      const fields: [string, string | undefined, (v: string) => void][] = [
        ["label", n.label, (v) => (n.label = v)],
        ...TEXT_FIELDS.map((f) => [f, typeof n.config[f] === "string" ? (n.config[f] as string) : undefined, (v: string) => (n.config[f] = v)] as [string, string | undefined, (v: string) => void]),
      ];
      for (const [field, text, set] of fields) {
        if (!text) continue;
        // Only rewrite text the edit itself didn't already change.
        const original = field === "label" ? p.label : (p.config[field] as string | undefined);
        if (original !== text) continue;
        const next = replaceAll(text, from, to);
        if (next !== text) {
          set(next);
          refreshed.push({ nodeId: n.id, field, before: text, after: next });
        }
      }
    }
  }

  // Other nodes still quoting a changed amount: report so the person can decide.
  for (const { nodeId, from } of changedValues) {
    for (const n of after.nodes) {
      if (n.id === nodeId) continue;
      for (const [field, text] of [["label", n.label] as const, ...TEXT_FIELDS.map((f) => [f, n.config[f]] as const)]) {
        if (typeof text === "string" && findSpelling(text, from)) stale.push({ nodeId: n.id, field, text, value: from });
      }
    }
  }
  return { refreshed, stale };
}

export function labelOf(n: GraphNode) {
  return n.label ?? n.id;
}
