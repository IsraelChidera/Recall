"use client";

import { AnalysisPanel } from "@/components/analysis/analysis-panel";
import { useAuth } from "@/components/auth/auth-provider";

export default function DashboardPage() {
  const auth = useAuth();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Unfinished work from your conversations appears here.
        </p>
      </header>
      {auth.status === "signedIn" ? <AnalysisPanel uid={auth.user.uid} /> : null}
    </main>
  );
}
