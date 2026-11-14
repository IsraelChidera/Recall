import { getAnalysisDeps } from "@/lib/server/analysis/deps";
import { JobError, startJob } from "@/lib/server/analysis/job";
import { jobErrorResponse, jobResponse } from "@/lib/server/analysis/respond";
import { withAuth } from "@/lib/server/with-auth";

/** Starts an analysis job for the caller, or reopens their unfinished one. */
export const POST = withAuth(async (_request, auth) => {
  try {
    if (!auth.aiAllowed) throw new JobError(403, "AI analysis is not enabled for this account.");
    return jobResponse(await startJob(getAnalysisDeps(), auth.uid));
  } catch (error) {
    return jobErrorResponse(error);
  }
});
