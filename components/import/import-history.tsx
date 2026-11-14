"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  deleteImport,
  deleteSourceData,
  listImports,
  type ImportRecord,
} from "@/lib/import/firestore-writer";
import { getFirebaseServices } from "@/lib/firebase/client";

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const numberFormat = new Intl.NumberFormat("en-GB");

const STATUS_TEXT: Record<ImportRecord["status"], string> = {
  completed: "Saved",
  writing: "Interrupted. Upload the same files to continue.",
  paused: "Interrupted. Upload the same files to continue.",
  parsing: "Interrupted. Upload the same files to continue.",
  failed: "Failed",
};

type State =
  | { name: "loading" }
  | { name: "error" }
  | { name: "ready"; records: ImportRecord[] };

type Pending = { target: string; stage: "confirm" | "deleting"; deleted: number };

const SOURCE_ID = "claude";
const ALL = "__all__";

export function ImportHistory({ uid, refreshKey }: { uid: string; refreshKey: number }) {
  const [state, setState] = useState<State>({ name: "loading" });
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const records = await listImports(getFirebaseServices().db, uid);
      setState({ name: "ready", records });
    } catch {
      setState({ name: "error" });
    }
  }, [uid]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data on mount and after each import
    void load();
  }, [load, refreshKey]);

  async function runDelete(target: string) {
    setFailure(null);
    setPending({ target, stage: "deleting", deleted: 0 });
    const onProgress = (deleted: number) => setPending({ target, stage: "deleting", deleted });
    try {
      const { db } = getFirebaseServices();
      if (target === ALL) await deleteSourceData(db, uid, SOURCE_ID, onProgress);
      else await deleteImport(db, uid, { id: target }, SOURCE_ID, onProgress);
    } catch {
      setFailure("Deleting stopped before it finished. Nothing is left half-deleted; try again to continue.");
    } finally {
      setPending(null);
      await load();
    }
  }

  if (state.name === "loading") {
    return <div aria-busy="true" className="h-16 animate-pulse rounded-lg bg-muted" />;
  }
  if (state.name === "error") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Import history could not be loaded. Check your connection and reload.
      </p>
    );
  }
  if (state.records.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has been saved yet.</p>;
  }

  const busy = pending?.stage === "deleting";

  return (
    <div className="flex flex-col gap-4">
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <ul className="divide-y rounded-lg border bg-card">
        {state.records.map((record) => {
          const saved = record.cursor;
          const isPending = pending?.target === record.id;
          return (
            <li key={record.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">
                  {record.createdAt ? dateTimeFormat.format(record.createdAt) : "Just now"}
                  <span className="text-muted-foreground">
                    {" · "}
                    {numberFormat.format(saved)} saved
                    {record.counts.unchanged > 0
                      ? `, ${numberFormat.format(record.counts.unchanged)} already up to date`
                      : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{STATUS_TEXT[record.status]}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isPending && pending.stage === "confirm" ? (
                  <>
                    <span className="text-xs text-muted-foreground">Delete its conversations?</span>
                    <Button size="sm" variant="destructive" onClick={() => runDelete(record.id)}>
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                      Keep
                    </Button>
                  </>
                ) : isPending ? (
                  <span role="status" className="text-xs text-muted-foreground tabular-nums">
                    Deleting… {numberFormat.format(pending.deleted)}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPending({ target: record.id, stage: "confirm", deleted: 0 })}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {pending?.target === ALL && pending.stage === "confirm" ? (
          <>
            <span className="text-sm text-muted-foreground">
              Delete every imported conversation and this history?
            </span>
            <Button size="sm" variant="destructive" onClick={() => runDelete(ALL)}>
              Delete everything
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Keep
            </Button>
          </>
        ) : pending?.target === ALL ? (
          <span role="status" className="text-sm text-muted-foreground tabular-nums">
            Deleting… {numberFormat.format(pending.deleted)} conversations
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setPending({ target: ALL, stage: "confirm", deleted: 0 })}
          >
            Delete all imported conversations
          </Button>
        )}
      </div>
    </div>
  );
}
