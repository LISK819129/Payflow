# PayFlow

**Tell PayPal how your money should behave.**

PayFlow compiles plain-language financial intent into versioned, policy-enforced workflows that run against real PayPal Sandbox APIs and webhooks — with human approval gates, scoped agent capabilities, a pre-activation simulator, and a hash-chained audit trail.

> AI interprets. Code enforces. Humans authorize. PayPal executes.

Status: in active development for the PayPal AI Hackathon 2026. See [BUILD_STATUS.md](BUILD_STATUS.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/PAYPAL_CAPABILITY_MAP.md](docs/PAYPAL_CAPABILITY_MAP.md).

## Run locally

Requires Node 20.9+ and pnpm.

```bash
pnpm install
pnpm env:init        # creates .env.local with generated local secrets
pnpm db:start        # local PostgreSQL on :54329 (keep running)
pnpm db:migrate
pnpm db:seed         # PixelForge workspace + owner (login in .env.local)
pnpm dev
```

Tests: `pnpm test` (uses the `payflow_test` database).

## License

MIT
