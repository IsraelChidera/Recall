import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-16">
      <Link
        href="/"
        className="font-mono text-xs tracking-widest text-muted-foreground uppercase"
      >
        Recall
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </header>
      {children}
      {footer ? <footer className="text-sm text-muted-foreground">{footer}</footer> : null}
    </main>
  );
}

export function FormMessage({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          : "rounded-md border bg-muted px-3 py-2 text-sm text-foreground"
      }
    >
      {children}
    </p>
  );
}
