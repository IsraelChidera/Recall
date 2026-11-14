"use client";

import { signOut } from "firebase/auth";
import { LayoutDashboard, LogOut, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { ensureUserProfile } from "@/lib/auth/profile";
import { getFirebaseServices } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";

// Screens are added here as their milestones land.
const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/import", label: "Import", icon: Upload },
];

function ShellSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-1 items-center justify-center">
      <div className="h-2 w-24 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

/**
 * Client-side route guard and application frame.
 *
 * Private data is never server-rendered: it is fetched in the browser under
 * Firestore Security Rules or from API routes that verify the ID token. This
 * guard therefore protects navigation, not data.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [profileError, setProfileError] = useState(false);

  const ready = auth.status === "signedIn" && auth.emailVerified;
  const uid = auth.status === "signedIn" ? auth.user.uid : null;

  useEffect(() => {
    if (auth.status === "signedOut") router.replace("/login");
    if (auth.status === "signedIn" && !auth.emailVerified) router.replace("/verify-email");
  }, [auth, router]);

  useEffect(() => {
    if (!ready || !uid) return;
    let cancelled = false;
    ensureUserProfile(uid).catch(() => {
      if (!cancelled) setProfileError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, uid]);

  if (auth.status === "misconfigured") {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-2 px-6">
        <h1 className="text-lg font-semibold">Recall is not configured</h1>
        <p className="text-sm text-muted-foreground">{auth.message}</p>
      </main>
    );
  }

  if (!ready) return <ShellSkeleton />;

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <aside className="relative flex shrink-0 flex-col gap-6 border-b bg-card px-4 py-4 md:w-60 md:border-r md:border-b-0 md:py-6">
        <Link href="/dashboard" className="px-2 font-mono text-xs tracking-widest uppercase">
          Recall
        </Link>
        <nav aria-label="Main" className="flex gap-1 md:flex-col">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                pathname === href && "bg-accent font-medium text-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t pt-4 max-md:hidden">
          <p className="truncate px-2 text-xs text-muted-foreground" title={auth.user.email ?? ""}>
            {auth.user.email}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            onClick={() => signOut(getFirebaseServices().auth)}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-3 right-3 md:hidden"
          onClick={() => signOut(getFirebaseServices().auth)}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {profileError ? (
          <p role="status" className="border-b bg-muted px-6 py-2 text-sm text-muted-foreground">
            Recall could not reach your workspace data. Check your connection and reload.
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
