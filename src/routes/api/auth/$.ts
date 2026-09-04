import { createFileRoute } from "@tanstack/react-router";

/** Better Auth: sign-in, callback and session endpoints under /api/auth/*. */
async function handle({ request }: { request: Request }): Promise<Response> {
  const { auth } = await import("@/lib/auth/server");
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
