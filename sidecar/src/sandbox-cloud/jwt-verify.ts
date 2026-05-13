/**
 * JWT verification for sandbox RPC tokens.
 *
 * Uses jose.jwtVerify with a JWKS fetched from the api's well-known endpoint.
 * The JWKS instance is cached at module level — jose's createRemoteJWKSet
 * handles cache refresh and key rotation automatically (re-fetches on unknown kid).
 *
 * Algorithm enforced: ES256 only. Issuer enforced: "veesker-cloud".
 * Any token that fails these checks is rejected.
 */

import { jwtVerify, createRemoteJWKSet } from "jose";

// Cached per apiBaseUrl so tests can use different base URLs without collision.
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(apiBaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksSets.has(apiBaseUrl)) {
    const url = new URL("/.well-known/jwks.json", apiBaseUrl);
    jwksSets.set(
      apiBaseUrl,
      createRemoteJWKSet(url, {
        cacheMaxAge: 600_000,   // 10 minutes — matches server Cache-Control max-age
        cooldownDuration: 30_000, // 30s between refetches after an unknown kid
      }),
    );
  }
  return jwksSets.get(apiBaseUrl)!;
}

export interface JwtClaimsResult {
  sub: string;
  email: string;
}

/**
 * Verify an ES256 JWT against the api's published JWKS.
 * Throws if the token is invalid, expired, has wrong algorithm, or wrong issuer.
 * Returns { sub, email } on success.
 */
export async function verifyJwtClaims(
  token: string,
  apiBaseUrl: string,
): Promise<JwtClaimsResult> {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("apiToken is empty or missing");
  }

  const jwks = getJwks(apiBaseUrl);

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, jwks, {
      algorithms: ["ES256"],
      issuer: "veesker-cloud",
      audience: "veesker-sidecar",
      clockTolerance: 30,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`apiToken verification failed: ${reason}`);
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("apiToken JWT is missing required claim 'sub'");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("apiToken JWT is missing required claim 'email'");
  }

  return { sub: payload.sub, email: payload.email };
}

/** Exposed for testing: clear the JWKS cache so tests can inject a fresh set. */
export function _clearJwksCache(): void {
  jwksSets.clear();
}
