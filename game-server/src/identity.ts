/**
 * Account linking: the site signs players in (Better Auth, "Sign in with X"
 * through the Grok broker) and mints a one-time ticket; the client hands the
 * ticket and the site origin to the arena in HELLO, and the arena redeems it
 * against the site. No secret is shared between the two deployments: trust is
 * the allowlist of site hostnames plus the ticket being random, short-lived
 * and single-use on the site.
 */

export interface Identity {
  /** Stable account id from the site's user table. */
  sub: string;
  /** Public handle, lower-case, 2 to 24 of [a-z0-9_]. */
  handle: string;
  /** Display name at sign-in time. */
  name: string;
  /** Avatar URL, or "". */
  avatar: string;
}

const HANDLE_RE = /^[a-z0-9_]{2,24}$/;

export function cleanHandle(raw: string): string {
  const h = raw
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
  return HANDLE_RE.test(h) ? h : "";
}

export class IdentityGate {
  private readonly hosts: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(hostnames: string[], fetchImpl: typeof fetch = fetch) {
    this.hosts = hostnames.map((h) => h.trim().toLowerCase()).filter(Boolean);
    this.fetchImpl = fetchImpl;
  }

  /** True when the origin's hostname is a site we accept tickets from. */
  allows(origin: string): boolean {
    let host = "";
    try {
      const u = new URL(origin);
      if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1")
        return false;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));
  }

  /** Redeem a ticket with the site; null when it is invalid, expired or the site is down. */
  async redeem(origin: string, ticket: string): Promise<Identity | null> {
    if (!this.allows(origin) || !/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) return null;
    try {
      const res = await this.fetchImpl(
        `${origin.replace(/\/$/, "")}/api/identity/redeem?t=${encodeURIComponent(ticket)}`,
        { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as Partial<Identity> & { ok?: boolean };
      if (!j || !j.ok || typeof j.sub !== "string" || !j.sub) return null;
      const handle = cleanHandle(typeof j.handle === "string" ? j.handle : "");
      if (!handle) return null;
      return {
        sub: j.sub.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64),
        handle,
        name: (typeof j.name === "string" ? j.name : "").slice(0, 40),
        avatar:
          typeof j.avatar === "string" && /^https:\/\/[^\s"'<>]{1,300}$/.test(j.avatar)
            ? j.avatar
            : "",
      };
    } catch {
      return null;
    }
  }
}

export function identityGateFromEnv(): IdentityGate {
  const list = (
    process.env.IDENTITY_HOSTNAMES ??
    process.env.TURNSTILE_HOSTNAMES ??
    "snek.grok.me,mmo.agenc.ag,agencoil.vercel.app,agencoil.grok.me,*.grok-sandbox.com,localhost,127.0.0.1"
  ).split(",");
  return new IdentityGate(list);
}
