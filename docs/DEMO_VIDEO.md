# PayFlow — final demo video: shot list

**Length:** 2:40–2:50. **Hard limit: under 3:00** (the hackathon rule). One story, almost all of it in the live app. No slides, no terminal, no music you don't have the rights to — it must work **muted**: the short overlays and the product tell the story.

**The story:** AI agents increasingly need to spend money. Handing them payment credentials hands them the power to pay anyone, anything. PayFlow gives them *permission to ask* — and checks every request against the authority you delegated before PayPal moves a cent.

## What the video must never imply

- that the **AI authorizes** a payment — it supplies evidence; PayFlow's authority decides;
- that a **Test run** moved money — the black *TEST RUN — NO MONEY MOVED — PAYPAL NOT CONTACTED* banner stays visible in every test scene;
- that **Submitted** means **Settled** — say "settled" only where the screen says *Settled*;
- that mock data is real — every scene below is the real product; nothing is mocked;
- that this is live money — the *PayPal · Sandbox* indicator is on every screen; say "Sandbox" at least once.

## Before recording (local, ~10 minutes)

1. Start PayFlow (docs/JUDGE_TESTING.md, Part 1). Sign in. **Settings → Restore demo setup.**
2. **The settled payment already exists** — receipt **`PF-3YA8N6MA`** ($15.00 → AWS Demo, allowed automatically, *Settled*, PayPal batch `PNEA99DU4KEVW`). Do **not** send another payment for the video.
3. Create the waiting approval for scene 7 (creating it moves no money):

   ```bash
   pnpm agent:mcp call payflow_request_payment scripts/agent-demo/requests/request-650-aws.json
   ```

   On camera, **hover *Approve once* but do not click it** — clicking sends a real $650 Sandbox payout. Afterwards press **Reject**, or let it expire.
4. Run the four examples once off-camera (Workflows → Cloud procurement → **Test run** → each example): the AI analyses are then cached, so on camera they return instantly and cost nothing.
5. Scene 4 (the AI-built rule): either record one real compile (about 15–40 s of waiting to cut; ≈ $0.03 of OpenAI), or open the stored result of the real compile — `http://localhost:3000/flows?compilation=98a5ebe6-5237-499f-8487-6859d52917b7` — which shows the same screen, labelled *Stored result*.
6. Browser: one window, 1920×1080, zoom 110 %, no bookmarks bar, no other tabs, notifications off. Nothing on screen from `.env` files, terminals, or email. Crop the address bar in the edit.
7. Recorder: Windows Game Bar (Win + Alt + R) or OBS Studio (free), 1080p, 30 fps. Keep the raw recordings.

## Shot list

Overlays are 2–5 words, bottom-left or top-right, never over the part of the UI being shown. `[TEST RUN]` / `[REAL PAYPAL SANDBOX]` are small persistent corner tags for those scenes.

| # | Time | Screen and action | Overlays (in order) |
|---|---|---|---|
| 1 | 0:00–0:06 | White screen. **PayFlow** fades in (black); the cyan marker draws behind **Flow**; subtitle fades in. Use `docs/assets/payflow-logo.svg`. | *Financial authority for AI agents* |
| 2 | 0:06–0:20 | **Home**, top of page, still. Then a slow push to **One agent, four requests**. | *AI can ask* → *PayFlow decides* → *PayPal moves the money* |
| 3 | 0:20–0:34 | **Authority → Cloud procurement**: the one-sentence summary; glide over *To whom · How much · For what*. | *Delegated authority* → *Who · how much · for what* |
| 4 | 0:34–0:54 | **Workflows**: the rule typed in (*"Let the Cloud Procurement Agent pay Acme Cloud in USD up to $200 for cloud infrastructure. Anything above $200 should require my approval."*) → the clarifying question (*Acme Cloud's PayPal address?*) → the graph → **PayFlow validation** ticks → *"Your payment rule is ready — as a draft."* Cut all waiting. | *Describe the rule* → *Unclear? It asks* → *AI drafts the workflow* → *Deterministic validation* → *A person activates* |
| 5 | 0:54–1:08 | **Workflows → Cloud procurement → Test run → $185 · Acme Cloud · GPU compute → Run test.** Hold on the checks strip and *Allowed automatically*; the three tiles *Not contacted · $0 · $0*. | `[TEST RUN]` · *$185 · inside authority* → *Allowed* |
| 6 | 1:08–1:30 | **Test run → $470 · Acme Cloud · digital gift cards.** Hold on Supplier ✓ Currency ✓ Amount ✓ Budget ✓ **Purpose ✕**, then the **Delegated for / Requested for** lines. The most important 20 seconds: no rush. | `[TEST RUN]` · *Every limit passes…* → *Purpose ✕* → *Outside its purpose* → *A person decides* |
| 7 | 1:30–1:50 | **Approvals**: the agent's live **$650 → AWS** request. Hold on *Requested by AI agent*, **Amount ✕ — exceeds the delegated limit by $150**, *PayPal has not been contacted*. Move the cursor to **Approve once** (do not click), then to *"does not change the workflow's authority"*. | *$650 · over its limit* → *Approve once* → *Authority unchanged* |
| 8 | 1:50–2:05 | **Agents → Cloud Procurement Agent**: *Can request* and *Can never*; the request list with `PF-3YA8N6MA`. | *External AI agent · MCP* → *Permission to ask* → *Cannot approve itself* |
| 9 | 2:05–2:22 | Click **`PF-3YA8N6MA`**. Hold on the eight stages: **Authority ALLOW · Human approval NOT NEEDED · PayPal SETTLED — PayPal: SUCCESS, confirmed by webhook**. Then **PayPal events**: *PAYMENT.PAYOUTS-ITEM.SUCCEEDED · Signature verified · REAL PAYPAL SANDBOX*. | `[REAL PAYPAL SANDBOX]` · *$15 · allowed automatically* → *PayPal paid it* → *Settled — confirmed by PayPal* |
| 10 | 2:22–2:34 | Back on the receipt: **Intent Receipt — in plain words** (who asked · what · how much · to whom · why · under which authority · did a person decide · what PayPal reported) and *integrity verified*. | *Intent Receipt* → *Who · what · why* → *Integrity verified* |
| 11 | 2:34–2:42 | **Audit** → search `PF-3YA8N6MA` → *Chain intact*; the request → authority → PayPal → settlement entries. | *Tamper-evident audit* |
| 12 | 2:42–2:50 | White screen, **PayFlow** with the marker. Three lines appear one after another, then are replaced by the tagline. Fade out. | *AI can ask.* · *PayFlow decides.* · *PayPal moves the money.* → *Financial authority for AI agents* |

Total ≈ 2:50. If long, trim scene 3 first, then scene 4.

## Narration (optional — record later; the video works without it)

| Scene | Say |
|---|---|
| 2 | "AI agents are starting to buy things — cloud capacity, software, supplier invoices. To let them, we usually hand them payment credentials. But a PayPal key can pay anyone, any amount, for anything." |
| 3 | "PayFlow changes the model. The agent gets permission to ask. This agent may pay Acme Cloud and AWS, in dollars, up to five hundred a payment — for cloud infrastructure." |
| 4 | "You write the rule in plain English. If something's unclear, PayFlow asks. The AI drafts the workflow; PayFlow validates it deterministically; a person activates it." |
| 5 | "A test run uses the real decision engine with PayPal switched off. A hundred and eighty-five dollars of GPU compute: every check passes." |
| 6 | "Four hundred and seventy dollars — same supplier, under the limit, within budget. But the request says it's for gift cards, and this agent was authorized for cloud infrastructure. Outside its purpose, so a person decides. The AI supplies the evidence; it never decides." |
| 7 | "A live request from the agent: six-fifty to AWS, a hundred and fifty over its limit. PayPal hasn't been contacted. A person can approve it once — the agent's authority doesn't change." |
| 8 | "The agent talks to PayFlow over MCP. It can ask. It can never approve itself, raise its limits, or touch PayPal." |
| 9 | "And this one was inside its authority: fifteen dollars to AWS, allowed automatically, paid through the PayPal Sandbox, and confirmed by PayPal's signed webhook. Settled." |
| 10–11 | "Every request becomes an Intent Receipt — who asked, what, why, under which authority, and what PayPal reported — in a tamper-evident audit trail." |
| 12 | "PayFlow. Financial authority for AI agents." |

## Final check before uploading

- Under 3:00. Every overlay readable for at least 1.5 seconds. No stretch longer than ~5 seconds where nothing changes.
- The core idea is on screen by 0:15; real product by 0:20; a real PayPal settlement by 2:20.
- No password, key, agent token, `.env` file, terminal or address bar in any frame.
- Every "settled" matches a screen that says *Settled*; every test scene shows the *TEST RUN* banner.
- Upload to YouTube (check the Devpost form for the visibility it requires) and paste the link into Devpost.
