import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TICKET_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_ATTEMPTS_PER_MINUTE = 10;

interface TurnstileResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

interface PlayTicket {
  v: 1;
  j: string;
  i: string;
  e: number;
  s: number;
}

export interface PlayGateOptions {
  secret?: string;
  signingSecret: string;
  expectedAction?: string;
  allowedHostnames?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  ticketTtlMs?: number;
  sessionTtlMs?: number;
  attemptsPerMinute?: number;
}

export type IssueResult =
  | { ok: true; ticket: string; expiresAt: number }
  | { ok: false; status: number; error: string; retryAfter?: number };

/**
 * Exchanges a single-use Cloudflare Turnstile response for a short-lived,
 * IP-bound play ticket. The ticket is consumed before a WebSocket client may
 * spawn; a successful redemption grants that connection a longer session.
 */
export class PlayGate {
  readonly enabled: boolean;
  private readonly secret: string;
  private readonly signingSecret: string;
  private readonly expectedAction: string;
  private readonly allowedHostnames: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ticketTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly attemptsPerMinute: number;
  private readonly attempts = new Map<string, number[]>();
  private readonly usedTickets = new Map<string, number>();

  constructor(options: PlayGateOptions) {
    this.secret = options.secret?.trim() ?? "";
    this.enabled = Boolean(this.secret);
    this.signingSecret = options.signingSecret;
    this.expectedAction = options.expectedAction?.trim() || "play";
    this.allowedHostnames = new Set(
      (options.allowedHostnames ?? [])
        .map((hostname) => hostname.trim().toLowerCase())
        .filter(Boolean),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.attemptsPerMinute = options.attemptsPerMinute ?? DEFAULT_ATTEMPTS_PER_MINUTE;
  }

  async issue(turnstileToken: string, ip: string): Promise<IssueResult> {
    if (!this.enabled) return { ok: true, ticket: "", expiresAt: this.now() };
    if (!turnstileToken || turnstileToken.length > 2048) {
      return { ok: false, status: 400, error: "Human verification is required." };
    }
    const retryAfter = this.rateLimit(ip);
    if (retryAfter !== null) {
      return {
        ok: false,
        status: 429,
        error: "Too many verification attempts. Try again shortly.",
        retryAfter,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let verification: TurnstileResponse;
    try {
      const body = new URLSearchParams({
        secret: this.secret,
        response: turnstileToken,
        remoteip: ip,
      });
      const response = await this.fetchImpl(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`siteverify returned ${response.status}`);
      verification = (await response.json()) as TurnstileResponse;
    } catch {
      return { ok: false, status: 503, error: "Human verification is temporarily unavailable." };
    } finally {
      clearTimeout(timeout);
    }

    const hostname = verification.hostname?.toLowerCase() ?? "";
    if (
      !verification.success ||
      verification.action !== this.expectedAction ||
      (this.allowedHostnames.size > 0 && !this.allowedHostnames.has(hostname))
    ) {
      return { ok: false, status: 403, error: "Human verification failed. Please try again." };
    }

    const now = this.now();
    const ticket: PlayTicket = {
      v: 1,
      j: randomBytes(12).toString("base64url"),
      i: this.ipDigest(ip),
      e: now + this.ticketTtlMs,
      s: now + this.sessionTtlMs,
    };
    const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    return { ok: true, ticket: `${payload}.${this.sign(payload)}`, expiresAt: ticket.e };
  }

  /** Redeem and mark a play ticket spent. Returns the verified-session expiry. */
  redeem(text: string, ip: string): number | null {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    const dot = text.indexOf(".");
    if (dot < 1) return null;
    const payload = text.slice(0, dot);
    const signature = text.slice(dot + 1);
    if (!this.sameSignature(signature, this.sign(payload))) return null;

    let ticket: PlayTicket;
    try {
      ticket = JSON.parse(Buffer.from(payload, "base64url").toString()) as PlayTicket;
    } catch {
      return null;
    }
    const now = this.now();
    if (
      ticket.v !== 1 ||
      typeof ticket.j !== "string" ||
      typeof ticket.e !== "number" ||
      typeof ticket.s !== "number" ||
      ticket.e < now ||
      ticket.s < now ||
      ticket.i !== this.ipDigest(ip)
    ) {
      return null;
    }

    for (const [used, exp] of this.usedTickets) if (exp < now) this.usedTickets.delete(used);
    if (this.usedTickets.has(signature)) return null;
    this.usedTickets.set(signature, ticket.e);
    return ticket.s;
  }

  private rateLimit(ip: string): number | null {
    const now = this.now();
    // Addresses that stopped trying a minute ago are forgotten, so the map
    // does not grow with every visitor an arena ever saw.
    if (this.attempts.size >= 2000) {
      for (const [seen, at] of this.attempts) {
        if (at.every((t) => now - t >= 60_000)) this.attempts.delete(seen);
      }
    }
    const recent = (this.attempts.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.attemptsPerMinute) {
      const waitMs = 60_000 - (now - recent[0]!);
      this.attempts.set(ip, recent);
      return Math.max(1, Math.ceil(waitMs / 1000));
    }
    recent.push(now);
    this.attempts.set(ip, recent);
    return null;
  }

  private ipDigest(ip: string): string {
    return createHmac("sha256", this.signingSecret)
      .update(`play-ip:${ip}`)
      .digest("base64url")
      .slice(0, 22);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingSecret).update(`play:${payload}`).digest("base64url");
  }

  private sameSignature(actual: string, expected: string): boolean {
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export function playGateFromEnv(signingSecret: string): PlayGate {
  const allowedHostnames = (
    process.env.TURNSTILE_HOSTNAMES ??
    "snek.grok.me,mmo.agenc.ag,agencoil.vercel.app,agencoil.grok.me,localhost,127.0.0.1"
  ).split(",");
  return new PlayGate({
    secret: process.env.TURNSTILE_SECRET_KEY,
    signingSecret,
    expectedAction: process.env.TURNSTILE_ACTION ?? "play",
    allowedHostnames,
  });
}
