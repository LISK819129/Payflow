import { InternalAuthorityProvider } from "./internal";
import type { AuthorityProvider } from "./types";

const internal = new InternalAuthorityProvider();
const g = globalThis as unknown as { __authorityOverride?: AuthorityProvider };

/**
 * The single place that chooses who decides whether an action is authorized.
 * Today: PayFlow's own authority layer (`PayFlow → PayFlow authority → PayPal`).
 * An external authority service (`PayFlow → GatePal → PayPal`) would implement
 * `AuthorityProvider` and be returned here; nothing else changes.
 */
export function authorityProvider(): AuthorityProvider {
  return g.__authorityOverride ?? internal;
}

export function setAuthorityProviderForTests(p: AuthorityProvider | null) {
  g.__authorityOverride = p ?? undefined;
}

export type { AuthorityProvider, AuthorityRequest, AuthorityResult } from "./types";
