/**
 * Arena identity tickets (server only). A signed-in player gets a random
 * ticket bound to their account; the game server redeems it with a GET to
 * `/api/identity/redeem`. Tickets live for TICKET_HOURS so reconnects and
 * arena hops can present the same one.
 */
import { randomBytes } from "node:crypto";
import { getSql } from "./db";

const TICKET_HOURS = 12;

export interface TicketInfo {
  ticket: string;
  handle: string;
  name: string;
  avatar: string;
  expiresAt: string;
}

/** Lower-case [a-z0-9_], 2 to 15 long (X's limit), or "". */
export function toHandle(raw: string): string {
  const h = raw
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 15);
  return h.length >= 2 ? h : "";
}

interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  username?: string | null;
  displayUsername?: string | null;
}

/**
 * The broker's userinfo carries only sub, name and email (its discovery
 * document lists no username claim). For X sign-ins the email is synthetic,
 * and its local part is the X screen name, so that is the first choice.
 * Any username column a future broker adds comes next, then the display
 * name as a slug.
 */
export function pickHandle(u: UserRow, viaX: boolean): { handle: string; from: string } {
  const [local = "", domain = ""] = (u.email ?? "").split("@");
  const mailbox = /gmail|googlemail|icloud|outlook|hotmail|yahoo|proton/i;
  if (viaX && /^[A-Za-z0-9_]{1,15}$/.test(local) && domain && !mailbox.test(domain)) {
    const h = toHandle(local);
    if (h) return { handle: h, from: "email" };
  }
  const fromColumn = toHandle(u.username ?? u.displayUsername ?? "");
  if (fromColumn) return { handle: fromColumn, from: "username" };
  const fromName = toHandle(u.name ?? "");
  if (fromName) return { handle: fromName, from: "name" };
  return {
    handle: `player_${u.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(-8)
      .toLowerCase()}`,
    from: "id",
  };
}

export async function mintTicket(userId: string): Promise<TicketInfo> {
  const sql = await getSql();
  const users = await sql<UserRow>`SELECT * FROM "user" WHERE "id" = ${userId} LIMIT 1`;
  const u = users[0];
  if (!u) throw new Error("no such user");
  const name = (u.name ?? "").trim().slice(0, 40);
  const providers = await sql<{
    providerId: string;
  }>`SELECT "providerId" FROM "account" WHERE "userId" = ${userId}`;
  const viaX = providers.some((p) => p.providerId === "grok-x");
  const picked = pickHandle(u, viaX);
  const handle = picked.handle;
  // Domain and source only: enough to see what the broker sends, without the handle itself.
  console.log(
    `[identity] provider=${viaX ? "x" : providers.map((p) => p.providerId).join("+") || "none"} emailDomain=${(u.email ?? "").split("@")[1] ?? ""} handleFrom=${picked.from}`,
  );
  const avatar = u.image && /^https:\/\//.test(u.image) ? u.image.slice(0, 300) : "";
  await sql`DELETE FROM identity_ticket WHERE expires_at < now()`;
  const live = await sql<{ ticket: string; expires_at: string }>`
    SELECT ticket, expires_at::text AS expires_at FROM identity_ticket
    WHERE user_id = ${userId} AND expires_at > now() + interval '1 hour'
    ORDER BY expires_at DESC LIMIT 1`;
  if (live[0]) {
    await sql`UPDATE identity_ticket SET handle = ${handle}, name = ${name}, avatar = ${avatar}
              WHERE ticket = ${live[0].ticket}`;
    return { ticket: live[0].ticket, handle, name, avatar, expiresAt: live[0].expires_at };
  }
  const ticket = randomBytes(32).toString("base64url");
  const rows = await sql<{ expires_at: string }>`
    INSERT INTO identity_ticket (ticket, user_id, handle, name, avatar, expires_at)
    VALUES (${ticket}, ${userId}, ${handle}, ${name}, ${avatar}, now() + ${`${TICKET_HOURS} hours`}::interval)
    RETURNING expires_at::text AS expires_at`;
  return { ticket, handle, name, avatar, expiresAt: rows[0]?.expires_at ?? "" };
}

export interface RedeemedIdentity {
  sub: string;
  handle: string;
  name: string;
  avatar: string;
}

export async function redeemTicket(ticket: string): Promise<RedeemedIdentity | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) return null;
  const sql = await getSql();
  const rows = await sql<{ user_id: string; handle: string; name: string; avatar: string }>`
    SELECT user_id, handle, name, avatar FROM identity_ticket
    WHERE ticket = ${ticket} AND expires_at > now() LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return { sub: r.user_id, handle: r.handle, name: r.name, avatar: r.avatar };
}
