/**
 * Public handle for a signed-in player. Dependency-free so the arena
 * identity code and its tests can share it.
 *
 * The broker's userinfo carries only sub, name and email (its discovery
 * document lists no username claim), so the X screen name never reaches this
 * app. For X sign-ins the email is synthetic, and its local part has turned
 * out to be the numeric X user id: short ids passed the handle check and
 * became names like "3098700091", long ones fell through to the display
 * name. A real mailbox address, when X provides one, is no better a source:
 * its local part is private. So the email is never used. A username column,
 * should a future broker add one, comes first; then the display name as a
 * slug; then a stable id-based fallback.
 */

export interface HandleSource {
  id: string;
  name: string | null;
  username?: string | null;
  displayUsername?: string | null;
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

export function pickHandle(u: HandleSource): { handle: string; from: string } {
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
