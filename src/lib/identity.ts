/**
 * Client-callable server functions for account linking. The heavy lifting
 * lives in `identity.server.ts`, imported lazily so nothing server-only
 * reaches the browser bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

/** Whether real sign-in is available on this deployment. */
export const authStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { authConfigured } = await import("@/lib/auth/server");
  return { configured: Boolean(authConfigured) };
});

/** A ticket the arena can redeem for the signed-in player's identity. */
export const mintIdentity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { mintTicket } = await import("./identity.server");
    return mintTicket(context.userId);
  });
