import { getAnalysisDeps } from "@/lib/server/analysis/deps";
import { JobError } from "@/lib/server/analysis/job";
import { jobErrorResponse } from "@/lib/server/analysis/respond";
import { generateResumeInsights } from "@/lib/server/resume/generate";
import { withAuth } from "@/lib/server/with-auth";

// One model request.
export const maxDuration = 60;

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Context = { params: Promise<{ taskId: string }> };

/** Adds AI-identified, quote-checked points to the caller's continuation prompt for one task. */
export const POST = withAuth<Context>(async (_request, auth, context) => {
  try {
    if (!auth.aiAllowed) throw new JobError(403, "AI analysis is not enabled for this account.");
    const { taskId } = await context.params;
    // The path is built from the token's uid, so another user's task id
    // simply does not exist here.
    if (!TASK_ID.test(taskId)) throw new JobError(404, "Task not found.");
    const insights = await generateResumeInsights(getAnalysisDeps(), auth.uid, taskId);
    return Response.json(insights, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jobErrorResponse(error);
  }
});
