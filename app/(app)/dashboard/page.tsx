"use client";

import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";

import { authFetch } from "@/lib/auth/api-client";

type Session = { email: string | null; aiAllowed: boolean };

export default function DashboardPage() {
  const [session, setSession] = useState<Session | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/session")
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as Session;
      })
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch(() => {
        if (!cancelled) setSession("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Unfinished work from your conversations will appear here.
        </p>
      </header>

      <section className="flex flex-col items-start gap-3 rounded-lg border bg-card p-8">
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">Nothing imported yet</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Recall finds work by reading your Claude export. The Import Centre arrives in the
          next milestone. Until then, your account is set up and your data space is private
          to you.
        </p>
      </section>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {session === null
          ? "Checking your session…"
          : session === "error"
            ? "Could not confirm your session with the server."
            : session.aiAllowed
              ? "Server session confirmed. AI analysis is enabled for this account."
              : "Server session confirmed. AI analysis is not enabled for this account yet."}
      </p>
    </main>
  );
}
