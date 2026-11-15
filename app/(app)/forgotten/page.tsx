import type { Metadata } from "next";

import { ForgottenWork } from "@/components/discoveries/forgotten";

export const metadata: Metadata = { title: "Forgotten work" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Forgotten work</h1>
        <p className="text-sm text-muted-foreground">Things you meant to do that have gone quiet.</p>
      </header>
      <ForgottenWork />
    </main>
  );
}
