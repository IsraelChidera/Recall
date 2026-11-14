import "server-only";

import { AINotConfiguredError } from "@/lib/ai";

import { JobError } from "./job";
import type { JobView } from "./types";

const noStore = { "Cache-Control": "no-store" };

export function jobResponse(view: JobView): Response {
  return Response.json(view, { headers: noStore });
}

/** Maps pipeline errors to responses. Unknown errors are not described to the client. */
export function jobErrorResponse(error: unknown): Response {
  if (error instanceof JobError) {
    return Response.json({ error: error.message }, { status: error.status, headers: noStore });
  }
  if (error instanceof AINotConfiguredError) {
    return Response.json({ error: error.message }, { status: 503, headers: noStore });
  }
  console.error("Analysis job failed", error instanceof Error ? error.name : "unknown error");
  return Response.json(
    { error: "Analysis hit an unexpected problem. Try again." },
    { status: 500, headers: noStore },
  );
}
