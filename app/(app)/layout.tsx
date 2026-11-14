import type { ReactNode } from "react";

import { AppShell } from "@/components/app/app-shell";
import { AuthProvider } from "@/components/auth/auth-provider";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
