"use client";

import { CircleCheck, Inbox, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import type { JobView } from "@/lib/domain/job";

import { Exclusions } from "./exclusions";
import { useAnalysis, type Overview } from "./use-analysis";

const numberFormat = new Intl.NumberFormat("en-GB");
const n = (value: number) => numberFormat.format(value);

const STAGE_TEXT: Record<JobView["stage"], string> = {
  screening: "Finding conversations that may contain unfinished work",
  extraction: "Reading the shortlisted conversations",
  reconciliation: "Merging duplicates",
  done: "Finishing",
};

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col items-start gap-4 rounded-lg border bg-card p-8">{children}</section>;
}

function Consent({ onAccept }: { onAccept: () => Promise<void> }) {
  const [understood, setUnderstood] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <Card>
      <Sparkles className="size-5 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-base font-semibold">Before Recall reads your conversations with AI</h2>
      <div className="flex max-w-xl flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          To find unfinished work, Recall sends the text of your conversations to Google&apos;s Gemini
          API. Please read what that means.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            Recall uses Gemini&apos;s free tier. Under Google&apos;s terms for that tier, Google may use
            what is sent to improve its products, and human reviewers may read it.
          </li>
          <li>
            Before sending, Recall removes email addresses, phone numbers, long numbers and things
            that look like passwords or keys. Names and the substance of your conversations are
            still sent.
          </li>
          <li>You choose which conversations are analysed. Ones you leave out are never sent.</li>
          <li>
            You can turn this off at any time. That stops future analysis. It cannot take back what
            was already sent.
          </li>
        </ul>
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-foreground"
          checked={understood}
          onChange={(event) => setUnderstood(event.target.checked)}
        />
        I understand, and I want Recall to analyse my conversations with Gemini.
      </label>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          Your choice could not be saved. Check your connection and try again.
        </p>
      ) : null}
      <Button
        disabled={!understood || pending}
        onClick={async () => {
          setPending(true);
          setFailed(false);
          try {
            await onAccept();
          } catch {
            setFailed(true);
            setPending(false);
          }
        }}
      >
        Allow AI analysis
      </Button>
    </Card>
  );
}

function Progress({ job }: { job: JobView }) {
  const { progress } = job;
  return (
    <dl className="grid w-full gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
      {[
        ["Screened", progress.screened],
        ["Shortlisted", progress.shortlisted],
        ["Read in full", progress.analysed],
        ["Found", progress.tasksCreated],
      ].map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1 bg-card p-4">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{n(Number(value))}</dd>
        </div>
      ))}
    </dl>
  );
}

function Findings({ overview }: { overview: Overview }) {
  if (overview.findings.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-3">
      <h3 className="text-sm font-semibold">
        {overview.toReview === 1 ? "1 discovery to review" : `${n(overview.toReview)} discoveries to review`}
      </h3>
      <ul className="divide-y rounded-lg border">
        {overview.findings.map((finding) => (
          <li key={finding.id} className="flex flex-col gap-1 px-4 py-3">
            <span className="text-sm font-medium">{finding.title}</span>
            <q className="text-sm text-muted-foreground">{finding.quote}</q>
            {finding.needsAttention ? (
              <span className="text-xs text-muted-foreground">Recall is less sure about this one.</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {overview.toReview > overview.findings.length ? `Showing ${overview.findings.length}. ` : ""}
        Reviewing, approving and dismissing arrive in the next milestone.
      </p>
    </div>
  );
}

export function AnalysisPanel({ uid }: { uid: string }) {
  const { state, start, halt, setConsent, refresh } = useAnalysis(uid);

  if (state.name === "loading") {
    return <div aria-busy="true" aria-label="Loading" className="h-40 animate-pulse rounded-lg bg-muted" />;
  }
  if (state.name === "unavailable") {
    return (
      <Card>
        <h2 className="text-base font-semibold">Your workspace could not be loaded</h2>
        <p className="text-sm text-muted-foreground">Check your connection and reload the page.</p>
      </Card>
    );
  }

  const { overview, job, running, error } = state;

  if (overview.conversations === 0) {
    return (
      <Card>
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">Nothing imported yet</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Recall finds work by reading your Claude export. Start by importing it.
        </p>
        <Link href="/import" className={buttonVariants({ size: "sm" })}>
          Go to Import
        </Link>
      </Card>
    );
  }

  if (!overview.aiAllowed) {
    return (
      <Card>
        <h2 className="text-base font-semibold">AI analysis is not enabled for this account</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          {n(overview.conversations)} conversations are saved. To analyse them, add this account&apos;s
          email address to ALLOWED_EMAILS on the server.
        </p>
      </Card>
    );
  }

  if (!overview.consented) return <Consent onAccept={() => setConsent(true)} />;

  const paused = job !== null && (job.status === "paused_quota" || job.status === "paused_error");
  const finished = job?.status === "completed";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        {running && job ? (
          <>
            <h2 className="text-base font-semibold">Analysing your conversations</h2>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {STAGE_TEXT[job.stage]}. Keep this tab open; if you close it, analysis picks up where
              it stopped.
            </p>
            <Progress job={job} />
            <Button variant="outline" size="sm" onClick={halt}>
              Pause
            </Button>
          </>
        ) : running ? (
          <>
            <h2 className="text-base font-semibold">Starting analysis</h2>
            <div aria-busy="true" className="h-2 w-24 animate-pulse rounded-full bg-muted" />
          </>
        ) : paused && job ? (
          <>
            <h2 className="text-base font-semibold">Analysis paused</h2>
            <p role="status" className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {job.message ?? "Analysis stopped before it finished."} Nothing found so far is lost.
            </p>
            <Progress job={job} />
            <Button onClick={start}>Resume analysis</Button>
          </>
        ) : finished && job ? (
          <>
            <CircleCheck className="size-5" aria-hidden="true" />
            <h2 className="text-base font-semibold">Analysis complete</h2>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Read {n(job.progress.analysed)} of {n(job.progress.screened)} conversations in full.{" "}
              {job.progress.tasksCompleted > 0
                ? `${n(job.progress.tasksCompleted)} things you had already finished were recorded as done. `
                : ""}
              {job.progress.tasksMerged > 0
                ? `${n(job.progress.tasksMerged)} duplicates were merged. `
                : ""}
              {job.progress.discarded > 0
                ? `${n(job.progress.discarded)} AI suggestions were thrown away because their quotes could not be found in your conversations.`
                : ""}
            </p>
            {overview.waiting > 0 ? <Button onClick={start}>Analyse {n(overview.waiting)} more</Button> : null}
          </>
        ) : overview.waiting > 0 ? (
          <>
            <Sparkles className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-base font-semibold">
              {overview.waiting === 1
                ? "1 conversation is waiting to be analysed"
                : `${n(overview.waiting)} conversations are waiting to be analysed`}
            </h2>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Recall screens them first, then reads only the ones likely to contain unfinished work.
            </p>
            <Button onClick={start}>Start analysis</Button>
          </>
        ) : (
          <>
            <CircleCheck className="size-5" aria-hidden="true" />
            <h2 className="text-base font-semibold">Everything imported has been analysed</h2>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Import a newer export to look for new work.
            </p>
          </>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {job ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {n(job.usage.aiRequests)} of {n(job.usage.dailyCap)} AI requests used today.
          </p>
        ) : null}
      </Card>

      {!running ? <Findings overview={overview} /> : null}

      <Exclusions uid={uid} disabled={running} onChange={() => void refresh()} />

      <p className="text-xs text-muted-foreground">
        AI analysis is on.{" "}
        <button
          type="button"
          className="underline underline-offset-4 hover:text-foreground disabled:opacity-50"
          disabled={running}
          onClick={() => void setConsent(false)}
        >
          Turn it off
        </button>
      </p>
    </div>
  );
}
