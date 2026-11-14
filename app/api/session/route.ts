import { withAuth } from "@/lib/server/with-auth";

/** Returns the caller's verified identity and whether AI analysis is enabled for them. */
export const GET = withAuth(async (_request, auth) =>
  Response.json(
    { uid: auth.uid, email: auth.email, aiAllowed: auth.aiAllowed },
    { headers: { "Cache-Control": "no-store" } },
  ),
);
