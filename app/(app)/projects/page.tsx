import type { Metadata } from "next";

import { ProjectsList } from "@/components/discoveries/projects";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Work that spans conversations, with the decisions you made along the way.
        </p>
      </header>
      <ProjectsList />
    </main>
  );
}
