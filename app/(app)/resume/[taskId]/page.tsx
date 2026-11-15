import type { Metadata } from "next";
import { Suspense } from "react";

import { ResumePage } from "@/components/discoveries/resume";

export const metadata: Metadata = { title: "Resume" };

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      {/* The task id is only known at request time, so the client part suspends during prerendering. */}
      <Suspense fallback={<div aria-busy="true" className="h-32 animate-pulse rounded-lg bg-muted" />}>
        <ResumePage />
      </Suspense>
    </main>
  );
}
