@AGENTS.md

# PayFlow project rules

- Commits and PRs are authored by the repository owner only. Never add `Co-Authored-By: Claude`, "Generated with Claude Code", or any other AI attribution to commits, PR descriptions, or code comments.
- Read `ARCHITECTURE.md` and `BUILD_STATUS.md` before starting work. Update `BUILD_STATUS.md` when something is verified, never before.
- Financial logic lives in `src/server/**`. Route handlers and server actions only authenticate, parse, and call a module.
- No fake PayPal responses, no silent fallbacks. Missing credentials → "setup required"; PayPal failure → show the failure.
- Never `eval` or execute model output. AI output is validated against zod schemas and only ever routes through deterministic policy nodes.
- Tests: `pnpm db:start` in one terminal, then `pnpm test`. Tests use the `payflow_test` database only.
