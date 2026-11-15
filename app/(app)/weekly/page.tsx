import type { Metadata } from "next";

import { WeeklyIntelligence } from "@/components/discoveries/weekly";

export const metadata: Metadata = { title: "Weekly intelligence" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly intelligence</h1>
        <p className="text-sm text-muted-foreground">Where your commitments stand this week.</p>
      </header>
      <WeeklyIntelligence />
    </main>
  );
}
