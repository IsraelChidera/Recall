"use client";

import { AnalysisPanel } from "@/components/analysis/analysis-panel";
import { useAuth } from "@/components/auth/auth-provider";
import { DashboardSummary } from "@/components/discoveries/dashboard-summary";

export default function DashboardPage() {
  const auth = useAuth();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Where your unfinished work stands today.
        </p>
      </header>
      {auth.status === "signedIn" ? (
        <>
          <DashboardSummary />
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Analysis</h2>
            <AnalysisPanel uid={auth.user.uid} />
          </section>
        </>
      ) : null}
    </main>
  );
}
