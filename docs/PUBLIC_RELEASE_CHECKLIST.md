# Before making the repository public

Checked on 2026-10-11 against the working tree and the full git history. Re-run the commands at the bottom if anything is committed after this.

## Verified clean

| | Check | Result |
|---|---|---|
| [x] | PayPal client secret, PayPal client id, OpenAI key, session secret, local owner password | Not in any tracked file or any commit (compared by value against `.env.local`) |
| [x] | Agent bearer tokens (`pfa_…`) | None in files or history; evidence files are redacted to `pfa_…REDACTED`; screenshots show the credential blurred |
| [x] | Judge password | Exists only in Render (typed there by you); never on this computer or in git |
| [x] | PayPal Sandbox account passwords | Never requested, stored or used |
| [x] | Environment files | `.env.local`, `.env.agent.local`, `.env.deploy.local`, `.env.production.local*` are git-ignored (`.env*`); only `.env.example` is tracked, with placeholder values |
| [x] | Render | No Render API key, service id or database URL in the repository; `render.yaml` holds no secrets (checked by `pnpm deploy:check`) |
| [x] | License and assets | MIT `LICENSE` at the root. No font files are committed (fonts load at build time; Instrument Sans and IBM Plex Mono are SIL OFL). The logo is original. Screenshots are of PayFlow itself. Icons: Lucide (ISC) |
| [x] | Screenshots | Reviewed: no passwords, keys or tokens. They do show Sandbox identifiers (below) |

## Public by design — not secrets

- PayPal Sandbox webhook id `9MJ408823R309725D` and Sandbox app id `APP-3C947882UU923023A` — identifiers, useless without the secret.
- The two Sandbox recipient emails (`sb-yluat53193698@personal.example.com`, `sb-mnylb53193692@personal.example.com`) — test accounts on PayPal's Sandbox.
- Sandbox payout, capture, invoice and webhook ids in `evidence/` — proof of real Sandbox calls; no money.
- `.env.example`: the local-development database URL with the password `payflow-local-dev` — it only opens the embedded database on your own machine, and PayFlow refuses to start in production with it.
- `owner@pixelforge.test`, `judge@payflow.demo` — made-up logins, no passwords.

## Look at these yourself before pressing the button

- [ ] **Your commit identity.** Every commit is authored `Lisk <atul60930@gmail.com>`. Making the repository public makes that address public. If you would rather not, that requires rewriting history — decide before going public, not after.
- [ ] **`CLAUDE.md` and `AGENTS.md`** (repository root) are instructions for the AI coding assistant used during development. They are harmless and the README already says Claude Code was a development tool, but a public reader will see them. Keep or delete — your call.
- [ ] **`BUILD_STATUS.md`** is the full, candid build log (including things that failed and were fixed). Good evidence for judges; skim it once so nothing in it surprises you.
- [ ] **`docs/DEPLOYMENT.md` and `docs/JUDGE_TESTING.md`** mention example paths on your machine (`D:\Payflow`, `D:\.cache\bin\…`) as examples, and the name of your Sandbox app ("PixelForge"). Nothing sensitive.
- [ ] **`evidence/`** is about 70 MB of screenshots and JSON. It is the proof behind the README; keep it unless you want a lighter repository.
- [ ] **GitHub → Settings → Secrets / Deploy keys / Webhooks**: nothing there should reference a real key (none was added by this project).

## Make it public

GitHub → the repository → **Settings → General → Danger Zone → Change repository visibility → Make public**. Then open the repository page signed out (a private window): the README renders with the logo, the license is detected as **MIT**, and the screenshots load.

## Re-check commands (no secrets are printed)

```bash
pnpm test
```

```bash
pnpm deploy:check
```

```bash
git log --all --oneline -G "pfa_[0-9a-f]{12}_[A-Za-z0-9_-]{43}"
```

```bash
git log --all --oneline -G "sk-[A-Za-z0-9_-]{20,}"
```

The first must print **nothing** (no agent credential was ever committed). The second prints one commit — `3d9e64e`, which added a deliberately fake key (`sk-proj-abcdefghijklmnopqrstuvwxyz`) to a test that checks PayFlow rejects secrets written into `render.yaml`.
