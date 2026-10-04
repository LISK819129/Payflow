import { z } from "zod";

/**
 * What a model must return for each analysis, owned by PayFlow. Flat, every
 * field required (empty string / empty list when there is nothing), enums for
 * every verdict, so strict structured-output modes can enforce them and nothing
 * downstream ever parses prose. Free text is shown to people, never acted on.
 */

const line = z.string().max(240);
const injection = { injection_suspected: z.boolean(), injection_evidence: z.array(line).max(3) };

export const PurposeWire = z.object({
  classification: z.enum(["WITHIN_SCOPE", "OUTSIDE_SCOPE", "UNCERTAIN"]),
  category: z.string().max(60),
  reasons: z.array(line).max(4),
  source_references: z.array(line).max(4),
  missing_information: z.array(line).max(4),
  ...injection,
});
export type PurposeWire = z.infer<typeof PurposeWire>;

const Verdict = z.enum(["MATCH", "MISMATCH", "UNCERTAIN"]);

export const ContractWire = z.object({
  verdict: Verdict,
  findings: z
    .array(
      z.object({
        aspect: z.enum(["service", "amount", "fees", "parties", "term", "other"]),
        result: Verdict,
        detail: line,
        contract_quote: line,
        invoice_quote: line,
      }),
    )
    .max(8),
  missing_information: z.array(line).max(4),
  ...injection,
});
export type ContractWire = z.infer<typeof ContractWire>;

const Field = z.object({ found: z.boolean(), value: z.string().max(200), quote: line });

export const ExtractWire = z.object({
  counterparty: Field,
  invoice_number: Field,
  amount: Field,
  currency: Field,
  due_date: Field,
  purpose: Field,
  payment_terms: Field,
  line_items: z.array(z.object({ description: z.string().max(160), quantity: z.string().max(20), unit_price: z.string().max(30), total: z.string().max(30) })).max(20),
  ...injection,
});
export type ExtractWire = z.infer<typeof ExtractWire>;

export const BehaviorWire = z.object({
  assessment: z.enum(["CONSISTENT_WITH_HISTORY", "INCONSISTENT_WITH_HISTORY", "UNCERTAIN"]),
  explanation: z.string().max(600),
  concerns: z.array(line).max(5),
  source_references: z.array(line).max(5),
  ...injection,
});
export type BehaviorWire = z.infer<typeof BehaviorWire>;

export const InvoiceMatchWire = z.object({
  verdict: z.enum(["MATCH", "NO_MATCH", "UNCERTAIN"]),
  matched_invoice_id: z.string().max(60),
  reasons: z.array(line).max(4),
  ...injection,
});
export type InvoiceMatchWire = z.infer<typeof InvoiceMatchWire>;
