import { Suspense, type ReactNode } from "react";

import { AppShell } from "@/components/app/app-shell";
import { AuthProvider } from "@/components/auth/auth-provider";

function ShellFallback() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-1 items-center justify-center">
      <div className="h-2 w-24 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      {/*
        The shell reads the current path to highlight navigation. On routes
        with a dynamic segment the path is only known at request time, so the
        shell must sit inside a Suspense boundary to be prerendered.
      */}
      <Suspense fallback={<ShellFallback />}>
        <AppShell>{children}</AppShell>
      </Suspense>
    </AuthProvider>
  );
}
