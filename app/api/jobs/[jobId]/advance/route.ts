import { getAnalysisDeps } from "@/lib/server/analysis/deps";
import { advanceJob, JobError } from "@/lib/server/analysis/job";
import { jobErrorResponse, jobResponse } from "@/lib/server/analysis/respond";
import { withAuth } from "@/lib/server/with-auth";

// One call makes a few paced model requests. Well inside Vercel Hobby's limit.
export const maxDuration = 120;

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Does one bounded slice of work on the caller's job and reports progress. */
type Context = { params: Promise<{ jobId: string }> };

export const POST = withAuth<Context>(
  async (_request, auth, context) => {
    try {
      const { jobId } = await context.params;
      // The path is built from the token's uid, so another user's job id
      // simply does not exist here.
      if (!JOB_ID.test(jobId)) throw new JobError(404, "Job not found.");
      return jobResponse(await advanceJob(getAnalysisDeps(), auth.uid, jobId, auth.aiAllowed));
    } catch (error) {
      return jobErrorResponse(error);
    }
  },
);
