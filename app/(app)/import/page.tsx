import type { Metadata } from "next";

import { ImportCentre } from "@/components/import/import-centre";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Bring in your Claude conversations. The files are read on this device.
        </p>
      </header>
      <ImportCentre />
    </main>
  );
}
