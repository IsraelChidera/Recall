import type { Metadata } from "next";

import { Inbox } from "@/components/discoveries/inbox";

export const metadata: Metadata = { title: "Inbox" };

export default function InboxPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          What Recall found in your conversations. Approve what matters and dismiss the rest.
        </p>
      </header>
      <Inbox />
    </main>
  );
}
