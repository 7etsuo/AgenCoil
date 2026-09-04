import { createFileRoute } from "@tanstack/react-router";

/**
 * The game server calls this with the ticket a client presented in HELLO.
 * Answers the account behind it, or 404. Tickets are random 256-bit secrets,
 * so possession is the proof; nothing else about the caller is trusted.
 */
export const Route = createFileRoute("/api/identity/redeem")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const t = new URL(request.url).searchParams.get("t") ?? "";
        const { redeemTicket } = await import("@/lib/identity.server");
        const id = await redeemTicket(t).catch(() => null);
        const headers = { "content-type": "application/json", "cache-control": "no-store" };
        if (!id) return new Response(JSON.stringify({ ok: false }), { status: 404, headers });
        return new Response(JSON.stringify({ ok: true, ...id }), { headers });
      },
    },
  },
});
