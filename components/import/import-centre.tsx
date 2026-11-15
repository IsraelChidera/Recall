"use client";

import { CircleAlert, CircleCheck, CircleMinus, FileArchive, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { summarise, type ConversationSummary } from "@/lib/domain/conversation";
import { getFirebaseServices } from "@/lib/firebase/client";
import {
  FirestoreImportWriter,
  ImportCapacityError,
  loadSourceIndex,
  type WriteProgress,
} from "@/lib/import/firestore-writer";
import type { ImportProgress, ImportResult } from "@/lib/import/parse-export";
import { planImport, type ImportPlan, type SourceIndex } from "@/lib/import/plan";
import { ImportCancelledError, runImport, type ImportRun } from "@/lib/import/run-import";
import { cn } from "@/lib/utils";

import { ImportHistory } from "./import-history";

/** What is already saved, and what this export would add. Null when it could not be loaded. */
type Saved = { index: SourceIndex; plan: ImportPlan } | null;

type Phase =
  | { name: "idle" }
  | { name: "parsing"; progress: ImportProgress | null }
  | { name: "done"; result: ImportResult; summaries: ConversationSummary[]; saved: Saved }
  | { name: "saving"; progress: WriteProgress }
  | { name: "saved"; written: number; plan: ImportPlan }
  | { name: "failed"; message: string };

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat("en-GB");

function formatDate(iso: string | null): string {
  if (!iso) return "Unknown";
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "Unknown" : dateFormat.format(time);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-card p-5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

const FILE_STATUS = {
  parsed: { icon: CircleCheck, label: "Read", tone: "text-foreground" },
  ignored: { icon: CircleMinus, label: "Not needed", tone: "text-muted-foreground" },
  rejected: { icon: CircleAlert, label: "Problem", tone: "text-destructive" },
} as const;

export function ImportCentre() {
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [dragging, setDragging] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<ImportRun | null>(null);
  const filesRef = useRef<File[]>([]);

  useEffect(() => () => runRef.current?.cancel(), []);

  // Pass 1: read the export and compare it with what is already saved.
  const start = useCallback(
    (files: File[]) => {
      if (files.length === 0 || !uid) return;
      filesRef.current = files;
      const summaries: ConversationSummary[] = [];
      setPhase({ name: "parsing", progress: null });

      const run = runImport(files, {
        // Only text-free summaries are kept, so memory stays small.
        onBatch: (conversations) => {
          for (const conversation of conversations) summaries.push(summarise(conversation));
        },
        onProgress: (progress) => setPhase({ name: "parsing", progress }),
      });
      runRef.current = run;

      run.result
        .then(async (result) => {
          let saved: Saved = null;
          if (result.sourceId) {
            try {
              const index = await loadSourceIndex(getFirebaseServices().db, uid, result.sourceId);
              saved = { index, plan: planImport(summaries, index) };
            } catch {
              // The preview still shows; saving is offered once the workspace is reachable.
            }
          }
          setPhase({ name: "done", result, summaries, saved });
        })
        .catch((error: unknown) => {
          if (error instanceof ImportCancelledError) setPhase({ name: "idle" });
          else {
            setPhase({
              name: "failed",
              message: error instanceof Error ? error.message : "The import failed.",
            });
          }
        });
    },
    [uid],
  );

  // Pass 2: read the export again and write what is new or changed. Reading
  // twice keeps memory flat: conversation text is never held between passes.
  const save = useCallback(
    async (result: ImportResult, saved: NonNullable<Saved>) => {
      if (!uid || !result.sourceId || result.adapterVersion === null) return;
      const toWrite = saved.plan.new + saved.plan.updated;
      const writer = new FirestoreImportWriter(getFirebaseServices().db, uid, {
        sourceId: result.sourceId,
        adapterVersion: result.adapterVersion,
        importId: result.fingerprint,
        fileNames: result.files.filter((file) => file.status === "parsed").map((file) => file.name),
        plan: saved.plan,
        issues: result.issues,
        index: saved.index,
      });
      setPhase({ name: "saving", progress: { written: 0, toWrite } });

      let begun = false;
      try {
        await writer.begin();
        begun = true;
        const run = runImport(filesRef.current, {
          onBatch: async (conversations) => {
            setPhase({ name: "saving", progress: await writer.writeBatch(conversations) });
          },
        });
        runRef.current = run;
        await run.result;
        await writer.finish();
        setPhase({ name: "saved", written: writer.progress.written, plan: saved.plan });
      } catch (error) {
        if (begun) await writer.markPaused().catch(() => {});
        const written = writer.progress.written;
        const kept =
          written > 0
            ? ` ${numberFormat.format(written)} conversations were saved and are safe.`
            : "";
        setPhase(
          error instanceof ImportCancelledError
            ? { name: "idle" }
            : {
                name: "failed",
                message:
                  error instanceof ImportCapacityError
                    ? error.message
                    : `Saving stopped before it finished.${kept} Upload the same files to continue where it stopped.`,
              },
        );
      } finally {
        setHistoryKey((key) => key + 1);
      }
    },
    [uid],
  );

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    start(Array.from(event.dataTransfer.files));
  };

  const reset = () => {
    runRef.current?.cancel();
    runRef.current = null;
    filesRef.current = [];
    if (inputRef.current) inputRef.current.value = "";
    setPhase({ name: "idle" });
  };

  return (
    <div className="flex flex-col gap-8">
      {phase.name === "idle" || phase.name === "failed" ? (
        <>
          {phase.name === "failed" ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {phase.message}
            </p>
          ) : null}
          <label
            htmlFor="export-files"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-6 py-12 text-center transition-colors hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring",
              dragging && "border-foreground bg-accent",
            )}
          >
            <Upload className="size-5 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium">Drop your export ZIP files here, or choose them</span>
            <span className="max-w-md text-sm leading-relaxed text-muted-foreground">
              You can select every file from the export. Recall reads{" "}
              <span className="font-mono text-xs whitespace-nowrap">conversations-000.zip</span> and skips the rest.
            </span>
            <input
              ref={inputRef}
              id="export-files"
              type="file"
              accept=".zip,application/zip"
              multiple
              className="sr-only"
              onChange={(event) => start(Array.from(event.target.files ?? []))}
            />
          </label>

          <section className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            <h2 className="text-sm font-semibold text-foreground">How to get your export</h2>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              <li>In Claude, open Settings and request an export of your data.</li>
              <li>Claude emails you a link. Download the ZIP files it lists.</li>
              <li>Upload them here. They are opened in your browser and are never uploaded.</li>
            </ol>
          </section>
        </>
      ) : null}

      {phase.name === "parsing" ? (
        <section
          aria-live="polite"
          aria-busy="true"
          className="flex flex-col gap-4 rounded-lg border bg-card p-8"
        >
          <div className="flex items-center gap-3">
            <FileArchive className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-base font-semibold">Reading your export</h2>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/60" />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {phase.progress
              ? `${numberFormat.format(phase.progress.conversations)} conversations read · file ${phase.progress.fileIndex + 1} of ${phase.progress.fileCount}`
              : "Opening the archive…"}
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={reset}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      {phase.name === "done" ? (
        <ImportSummary
          phase={phase}
          onReset={reset}
          onSave={phase.saved ? () => save(phase.result, phase.saved as NonNullable<Saved>) : null}
        />
      ) : null}

      {phase.name === "saving" ? (
        <section
          aria-live="polite"
          aria-busy="true"
          className="flex flex-col gap-4 rounded-lg border bg-card p-8"
        >
          <h2 className="text-base font-semibold">Saving to your workspace</h2>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={phase.progress.toWrite}
            aria-valuenow={phase.progress.written}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-foreground/70 transition-[width]"
              style={{
                width: `${phase.progress.toWrite === 0 ? 0 : Math.round((phase.progress.written / phase.progress.toWrite) * 100)}%`,
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {numberFormat.format(phase.progress.written)} of{" "}
            {numberFormat.format(phase.progress.toWrite)} conversations saved. Keep this tab open.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={() => runRef.current?.cancel()}>
              Stop
            </Button>
          </div>
        </section>
      ) : null}

      {phase.name === "saved" ? (
        <section className="flex flex-col items-start gap-3 rounded-lg border bg-card p-8">
          <CircleCheck className="size-5" aria-hidden="true" />
          <h2 className="text-base font-semibold">
            Saved {numberFormat.format(phase.written)} conversations
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            {numberFormat.format(phase.plan.new)} new and {numberFormat.format(phase.plan.updated)}{" "}
            changed.{" "}
            {phase.plan.unchanged > 0
              ? `${numberFormat.format(phase.plan.unchanged)} were already up to date and were left alone. `
              : ""}
            They are stored in your private workspace. Next, let Recall look through them for
            unfinished work.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard" className={buttonVariants()}>
              Go to analysis
            </Link>
            <Button variant="outline" onClick={reset}>
              Import more
            </Button>
          </div>
        </section>
      ) : null}

      {uid && (phase.name === "idle" || phase.name === "saved" || phase.name === "failed") ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Saved imports</h2>
          <ImportHistory uid={uid} refreshKey={historyKey} />
        </section>
      ) : null}
    </div>
  );
}

function ImportSummary({
  phase,
  onReset,
  onSave,
}: {
  phase: Extract<Phase, { name: "done" }>;
  onReset: () => void;
  onSave: (() => void) | null;
}) {
  const { result, summaries, saved } = phase;
  const toWrite = saved ? saved.plan.new + saved.plan.updated : 0;
  const { stats } = result;
  const found = stats.conversations > 0;
  const recent = [...summaries]
    .sort((a, b) => (b.updatedAtSource ?? "").localeCompare(a.updatedAtSource ?? ""))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">
          {found
            ? `Found ${numberFormat.format(stats.conversations)} conversations`
            : "No conversations found"}
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          {!found
            ? "None of these files contained a conversations archive. Upload the file named conversations-000.zip from your export."
            : !saved
              ? "This is a preview. Recall could not reach your workspace to compare it with what is saved, so nothing can be saved right now. Check your connection and try again."
              : toWrite === 0
                ? "Nothing new in this export. Every conversation in it is already saved and up to date."
                : `${numberFormat.format(saved.plan.new)} new and ${numberFormat.format(saved.plan.updated)} changed since your last import. ${numberFormat.format(saved.plan.unchanged)} already saved. Nothing is saved until you choose to.`}
        </p>
        {found && saved && saved.plan.notInThisExport > 0 ? (
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            {numberFormat.format(saved.plan.notInThisExport)} conversations saved earlier are not in
            this export. They are kept.
          </p>
        ) : null}
        {found && onSave && toWrite > 0 ? (
          <div className="flex flex-wrap gap-3 pt-2">
            <Button size="lg" onClick={onSave}>
              Save {numberFormat.format(toWrite)} conversations
            </Button>
            <Button size="lg" variant="outline" onClick={onReset}>
              Cancel
            </Button>
          </div>
        ) : null}
      </section>

      {found ? (
        <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
          <Stat label="Conversations" value={numberFormat.format(stats.conversations)} />
          <Stat
            label="Messages"
            value={`${numberFormat.format(stats.messages)} (${numberFormat.format(stats.humanMessages)} yours)`}
          />
          <Stat label="Period" value={`${formatDate(stats.earliest)} to ${formatDate(stats.latest)}`} />
        </dl>
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Files</h3>
        <ul className="divide-y rounded-lg border bg-card">
          {result.files.map((file, index) => {
            const status = FILE_STATUS[file.status];
            const Icon = status.icon;
            return (
              <li key={`${file.name}-${index}`} className="flex items-start gap-3 px-4 py-3">
                <Icon className={cn("mt-0.5 size-4 shrink-0", status.tone)} aria-hidden="true" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono text-xs">{file.name}</span>
                  <span className={cn("text-sm", status.tone)}>
                    {status.label}
                    {file.status === "parsed" && file.conversations !== undefined
                      ? `: ${numberFormat.format(file.conversations)} conversations`
                      : file.reason
                        ? `: ${file.reason}`
                        : ""}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {found ? (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Most recent</h3>
          <ul className="divide-y rounded-lg border bg-card">
            {recent.map((conversation) => (
              <li key={conversation.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
                <span className="min-w-0 truncate text-sm">
                  {conversation.title || "Untitled conversation"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {numberFormat.format(conversation.messageCount)} messages ·{" "}
                  {formatDate(conversation.updatedAtSource)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {found ? (
        <section className="flex flex-col gap-2 text-sm text-muted-foreground">
          <h3 className="text-sm font-semibold text-foreground">Details</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {stats.offBranchMessages > 0 ? (
              <li>
                {numberFormat.format(stats.offBranchMessages)} messages from edited or regenerated
                turns were left out. Recall keeps the latest version of each conversation.
              </li>
            ) : null}
            {stats.truncatedMessages > 0 ? (
              <li>
                {numberFormat.format(stats.truncatedMessages)} long Claude replies were shortened.
                Your own messages are kept whole.
              </li>
            ) : null}
            {stats.duplicates > 0 ? (
              <li>
                {numberFormat.format(stats.duplicates)} conversations appeared more than once and
                were counted once.
              </li>
            ) : null}
            <li>Tool output and Claude&apos;s thinking are not imported.</li>
          </ul>
        </section>
      ) : null}

      {result.issueCount > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">
            {result.issueCount === 1
              ? "1 conversation could not be read"
              : `${numberFormat.format(result.issueCount)} conversations could not be read`}
          </h3>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {result.issues.map((issue, index) => (
              <li key={index} className="flex flex-col gap-0.5 px-4 py-3">
                <span>{issue.reason}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {issue.file}
                  {issue.sourceConversationId ? ` · ${issue.sourceConversationId}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {result.issueCount > result.issues.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {result.issues.length}.
            </p>
          ) : null}
        </section>
      ) : null}

      {result.warnings.map((warning) => (
        <p key={warning} role="status" className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}

      <div>
        <Button variant="outline" onClick={onReset}>
          Import different files
        </Button>
      </div>
    </div>
  );
}
