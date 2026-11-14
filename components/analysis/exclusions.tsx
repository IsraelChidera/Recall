"use client";

import { collection, doc, getDocs, limit, query, serverTimestamp, updateDoc } from "firebase/firestore";
import { useEffect, useState } from "react";

import { getFirebaseServices } from "@/lib/firebase/client";

type Row = { id: string; title: string; messageCount: number; updated: Date | null; excluded: boolean };

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const PAGE = 300;

/**
 * Lets the user leave conversations out of AI analysis. An excluded
 * conversation is never sent to the AI provider.
 */
export function Exclusions({ uid, disabled, onChange }: { uid: string; disabled: boolean; onChange: () => void }) {
  const [rows, setRows] = useState<Row[] | "error" | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || rows !== null) return;
    let cancelled = false;
    const { db } = getFirebaseServices();
    getDocs(query(collection(db, "users", uid, "conversations"), limit(PAGE)))
      .then((snapshot) => {
        if (cancelled) return;
        const loaded = snapshot.docs.map((entry) => {
          const data = entry.data();
          const updated = data.updatedAtSource as { toDate?: () => Date } | null | undefined;
          return {
            id: entry.id,
            title: String(data.title ?? ""),
            messageCount: Number(data.messageCount ?? 0),
            updated: updated?.toDate ? updated.toDate() : null,
            excluded: data.excluded === true,
          };
        });
        loaded.sort((a, b) => (b.updated?.getTime() ?? 0) - (a.updated?.getTime() ?? 0));
        setRows(loaded);
      })
      .catch(() => {
        if (!cancelled) setRows("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, rows, uid]);

  async function toggle(row: Row) {
    if (!Array.isArray(rows)) return;
    const excluded = !row.excluded;
    setRows(rows.map((entry) => (entry.id === row.id ? { ...entry, excluded } : entry)));
    try {
      await updateDoc(doc(getFirebaseServices().db, "users", uid, "conversations", row.id), {
        excluded,
        // Bringing a conversation back puts it on the analysis queue again.
        ...(excluded ? {} : { needsAnalysis: true }),
        updatedAt: serverTimestamp(),
      });
      onChange();
    } catch {
      setRows(rows);
    }
  }

  const excludedCount = Array.isArray(rows) ? rows.filter((row) => row.excluded).length : null;

  return (
    <details
      className="rounded-lg border bg-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Choose conversations to leave out
        {excludedCount ? (
          <span className="font-normal text-muted-foreground"> · {excludedCount} left out</span>
        ) : null}
      </summary>
      <div className="border-t">
        {rows === null ? (
          <div aria-busy="true" className="m-4 h-10 animate-pulse rounded-md bg-muted" />
        ) : rows === "error" ? (
          <p className="p-4 text-sm text-muted-foreground">The list could not be loaded.</p>
        ) : (
          <>
            <ul className="max-h-80 divide-y overflow-y-auto">
              {rows.map((row) => (
                <li key={row.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-foreground"
                      checked={!row.excluded}
                      disabled={disabled}
                      onChange={() => toggle(row)}
                      aria-label={`Include ${row.title || "untitled conversation"} in AI analysis`}
                    />
                    <span className={row.excluded ? "min-w-0 flex-1 truncate text-muted-foreground line-through" : "min-w-0 flex-1 truncate"}>
                      {row.title || "Untitled conversation"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {row.messageCount} messages{row.updated ? ` · ${dateFormat.format(row.updated)}` : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
              Ticked conversations are analysed. Unticked ones are never sent to the AI provider.
              {rows.length === PAGE ? ` Showing the first ${PAGE}.` : ""}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
