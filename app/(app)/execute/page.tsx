import type { Metadata } from "next";

import { ExecutionInbox } from "@/components/discoveries/execution";

export const metadata: Metadata = { title: "Execution" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Execution</h1>
        <p className="text-sm text-muted-foreground">Work you approved. Start it, finish it, or set it aside.</p>
      </header>
      <ExecutionInbox />
    </main>
  );
}
