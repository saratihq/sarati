// Liveness probe: no auth, no DB, no external calls. Must stay public in middleware.ts.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" });
}
