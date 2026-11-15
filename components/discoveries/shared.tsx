import type { ReactNode } from "react";

export function LoadingBlock() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <div className="h-28 animate-pulse rounded-lg bg-muted" />
      <div className="h-28 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

export function LoadError({ what }: { what: string }) {
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      {what} could not be loaded. Check your connection and reload the page.
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-8">
      <div className="max-w-md text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

/** A polite live region that takes no space while empty. */
export function Notice({ text }: { text: string | null }) {
  return (
    <div aria-live="polite" className={text ? undefined : "sr-only"}>
      {text ? <p className="rounded-md border bg-muted px-4 py-2.5 text-sm">{text}</p> : null}
    </div>
  );
}

/** Shown when more tasks exist than a screen loads, so its figures are not mistaken for totals. */
export function TruncatedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="rounded-md border bg-muted px-4 py-2.5 text-sm">
      You have more tasks than this page loads at once, so the figures here are a minimum. Completing or
      dismissing tasks brings the rest into view.
    </p>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
