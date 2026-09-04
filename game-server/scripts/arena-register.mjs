#!/usr/bin/env node
/**
 * Register, list or remove static arenas: machines you run yourself, reached
 * through a tunnel, that the coordinator places players on before it creates
 * any Sandbox. Reads DATABASE_URL from the environment.
 *
 *   node scripts/arena-register.mjs list
 *   node scripts/arena-register.mjs add home-1 https://arena1.example.com
 *   node scripts/arena-register.mjs remove home-1
 */
import pg from "pg";

const [cmd, name, domain] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
const STATIC_BUILD = "static";
// Far enough that rows() never filters a static arena out, and created_at
// low enough that pickArena prefers it over any Sandbox.
const FOREVER = Date.UTC(2100, 0, 1);

try {
  if (cmd === "list") {
    const r = await pool.query(
      "SELECT name, domain, build, created_at, expires_at FROM agencoil_arena ORDER BY created_at",
    );
    for (const a of r.rows) {
      let health = "unreachable";
      try {
        const j = await (
          await fetch(`${a.domain}/api/ws`, { signal: AbortSignal.timeout(4000) })
        ).json();
        health = `ok=${j.ok} draining=${j.draining} players=${j.players}`;
      } catch (e) {
        health = e.message;
      }
      console.log(
        `${a.build === STATIC_BUILD ? "static " : "sandbox"} ${a.name} ${a.domain} ${health}`,
      );
    }
  } else if (cmd === "add" && name && domain) {
    if (!/^[a-z0-9-]{2,32}$/.test(name)) throw new Error("name: 2 to 32 of [a-z0-9-]");
    const d = domain.replace(/\/$/, "");
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(d)) throw new Error("domain: https://host");
    await pool.query(
      `INSERT INTO agencoil_arena (name, domain, created_at, expires_at, build) VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (name) DO UPDATE SET domain = EXCLUDED.domain, expires_at = EXCLUDED.expires_at, build = EXCLUDED.build`,
      [name, d, FOREVER, STATIC_BUILD],
    );
    console.log(`registered ${name} at ${d}`);
  } else if (cmd === "remove" && name) {
    const r = await pool.query("DELETE FROM agencoil_arena WHERE name = $1 AND build = $2", [
      name,
      STATIC_BUILD,
    ]);
    console.log(r.rowCount ? `removed ${name}` : `no static arena called ${name}`);
  } else {
    console.error("usage: arena-register.mjs list | add <name> <https://host> | remove <name>");
    process.exit(2);
  }
} finally {
  await pool.end();
}
