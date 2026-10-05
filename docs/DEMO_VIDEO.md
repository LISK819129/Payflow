# PayFlow — demo video plan (target 2:40, hard limit < 3:00)

The rules require a video **under three minutes** showing the working project. This plan spends ~2:25 of 2:40 in the live app. No slides, no music (silence or your voice only — nothing copyrighted).

**The story in one line:** AI agents can act on their own now; giving them payment credentials is unsafe; PayFlow gives them *delegated financial authority* instead.

---

## Before you record (15 minutes)

1. Start PayFlow (docs/JUDGE_TESTING.md, Part 1) — or use the hosted site if it is live. Sign in. **Settings → Restore demo setup.**
2. **Recommended — one real settled payout to show (moves Sandbox test money; your decision):** follow docs/JUDGE_TESTING.md Part 3 A–E step 1 (tunnel + `request-185-acme.json`). Wait until that request's receipt says **Settled**. Note its reference (`PF-…`). If you skip this, use the Phase 9 receipt `PF-RUQN67G5` (a real Sandbox payout that ends *Awaiting recipient* — truthful, just less satisfying).
3. Create the pending approval for scene 6 (no money moves):

   ```bash
   pnpm agent:mcp call payflow_request_payment scripts/agent-demo/requests/request-650-aws.json
   ```

4. Run the three Test Runs once off-camera (Cloud procurement → Test this flow → each example) so the AI analyses are cached — on camera they return instantly and cost nothing.
5. Browser: one window, 1920×1080, zoom 110 %, no bookmarks bar, no other tabs, notifications off. Close anything showing `.env` files, terminals with secrets, or email.
6. Recorder: **Windows Game Bar** (Win + Alt + R starts/stops; Win + G for settings) or **OBS Studio** (free). Record the browser window at 1080p, 30 fps. Use a headset microphone; record narration in one take per scene if easier and join them.

## Timeline and narration

Words in *italics* are on screen; the quoted text is what you say (~145 words per minute).

| Time | Screen | Narration |
|---|---|---|
| **0:00–0:13** | **Home**, still. Headline visible. | "AI agents can now do real work — buy cloud capacity, pay suppliers, refund customers. But to let them, we usually hand them payment credentials. A PayPal token says *this software can call the API*. It doesn't say *this payment is authorized*." |
| **0:13–0:27** | Slowly scroll to the two pipelines (*When an AI agent asks*). | "PayFlow is the financial permission layer between AI agents and real money. AI can ask. PayFlow decides. PayPal moves the money." |
| **0:27–0:45** | **Authority → Cloud procurement.** Hover the sentence, then *To whom*, *How much*, *For what*. | "Here's the authority PixelForge delegates: pay Acme Cloud and AWS, up to five hundred dollars a payment, five thousand a month, in US dollars — and only for cloud infrastructure. Never Blocked Vendor. Anything else goes to a person." |
| **0:45–1:00** | **Flows → Cloud procurement → Test this flow → $185 · Acme Cloud → Run test.** Hold on *WOULD ALLOW* and the checks strip. Point at the black *TEST RUN — NO MONEY MOVED* banner. | "This is a Test Run — the real decision engine, but PayPal is never contacted and no budget is reserved. A hundred and eighty-five dollars of GPU compute from Acme: every check passes. It would go through on its own." |
| **1:00–1:20** | **Test this flow → $470 · Acme Cloud · digital gift cards → Run test.** Hold on *Purpose ✕*, then scroll to *Intelligence*: *Calculated by PayFlow* vs *AI interpretation — not fact*, and *The AI did not decide.* | "Four hundred and seventy dollars, approved supplier, under the limit, within budget — every classic check passes. But it's for gift cards. The AI reads the invoice and flags the purpose — as evidence. PayFlow's policy decides: a person must approve. The AI never decides." |
| **1:20–1:45** | **Approvals** — the agent's real **$650 AWS** request. Hold on *Requested by AI agent*, *Amount ✕*, *exceeds the delegated limit by $150*, *PayPal has not been contacted*, the **Approve once / Reject** buttons. | "Now a real request from an AI agent, over PayFlow's MCP server: six hundred and fifty dollars to AWS. It's a hundred and fifty over its authority, so it stops here. PayPal hasn't been contacted. A person can approve once — that covers this one request and never raises the limit — or reject it." |
| **1:45–2:00** | **Agents → Cloud Procurement Agent.** Hold on *Can request* and *Can never*. | "The agent itself has an identity, an owner and an expiry. It can ask for payouts through one workflow. It can never approve, change its own rules, or touch PayPal. Revoke it, and its very next call is refused." |
| **2:00–2:20** | **The settled receipt** (`/agents/requests/PF-…` from step 2). Show the eight stages, *The receipt in plain words*, then scroll *What happened next (hash-linked)* to *PayPal settlement*. Label on screen: *REAL PAYPAL SANDBOX*. | "When a request is allowed, this is its Intent Receipt — a real PayPal Sandbox payout. Who asked, how much, to whom, why, under which authority version. Then the hash-linked outcome: the decision, PayPal's result, PayPal's signed webhook, and settlement." |
| **2:20–2:33** | **PayPal events** (signed, verified, *REAL PAYPAL SANDBOX*), then **Audit** → search the receipt's `PF-…` → *Chain intact*. | "Every PayPal webhook is signature-verified and confirmed with PayPal before it counts. And every step lands in a tamper-evident, hash-chained audit trail." |
| **2:33–2:42** | Back to **Home**, still. | "PayFlow. Financial authority for AI agents. AI can ask. PayFlow decides. PayPal moves the money." |

Total ≈ 2:42. If you run long, shorten the Authority scene (0:27–0:45) first.

## Honesty rules for the video

- Say **"Test Run"** whenever a test result is on screen; the black banner must be visible at least once.
- Only call something "real PayPal Sandbox" when it is (receipts of real payouts, PayPal events). Never show a Test Run as a real payment.
- Don't show a terminal, `.env` file, credential, or the agent token. If you show the `pnpm agent:mcp` command, show the command line only.
- Everything is PayPal **Sandbox** — say "Sandbox" at least once (the indicator is in the sidebar).

## After recording

- Upload to YouTube (Unlisted is fine) or Vimeo; paste the link into Devpost.
- Watch it once at normal speed: under 3:00, readable text, no secrets on screen.
