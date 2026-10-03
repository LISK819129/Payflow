// Scripts run outside Next.js, so load the same env files it would.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });
