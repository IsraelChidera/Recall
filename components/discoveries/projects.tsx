"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InvalidEditError,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  sourceUrlFor,
  type ProjectView,
  type TaskEdit,
  type TaskView,
} from "@/lib/discoveries/model";
import { editProject, listProjects, loadProject, reviewTask, type ProjectDetail } from "@/lib/discoveries/store";
import { getFirebaseServices } from "@/lib/firebase/client";

import { TaskCard } from "./task-card";

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

function Skeleton() {
  return <div aria-busy="true" className="h-32 animate-pulse rounded-lg bg-muted" />;
}

export function ProjectsList() {
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const [projects, setProjects] = useState<ProjectView[] | "error" | null>(null);

  useEffect(() => {
    if (!uid) return;
    listProjects(getFirebaseServices().db, uid).then(setProjects, () => setProjects("error"));
  }, [uid]);

  if (projects === null) return <Skeleton />;
  if (projects === "error") {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        Your projects could not be loaded. Check your connection and reload the page.
      </p>
    );
  }
  const visible = projects.filter((project) => !project.archived);
  const archived = projects.length - visible.length;
  if (projects.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8">
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          No projects yet. Recall groups discoveries into a project when a conversation is clearly
          about one.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {visible.map((project) => (
          <li key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              className="flex flex-col gap-1.5 rounded-lg border bg-card p-5 transition-colors hover:bg-accent/50"
            >
              <span className="text-base font-semibold">{project.name}</span>
              {project.description ? (
                <span className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                  {project.description}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {project.conversationIds.length === 1
                  ? "1 conversation"
                  : `${project.conversationIds.length} conversations`}
                {project.lastActivityAt ? ` · last active ${dateFormat.format(project.lastActivityAt)}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {archived > 0 ? (
        <p className="text-xs text-muted-foreground">
          {archived === 1 ? "1 archived project is hidden." : `${archived} archived projects are hidden.`}
        </p>
      ) : null}
    </div>
  );
}

const OPEN = new Set(["awaiting_review", "approved", "in_progress"]);

export function ProjectPage() {
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const { projectId } = useParams<{ projectId: string }>();
  const [detail, setDetail] = useState<ProjectDetail | "missing" | "error" | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!uid) return;
    try {
      setDetail((await loadProject(getFirebaseServices().db, uid, projectId)) ?? "missing");
    } catch {
      setDetail("error");
    }
  }, [uid, projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data on mount
    void load();
  }, [load]);

  if (detail === null) return <Skeleton />;
  if (detail === "error" || detail === "missing") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {detail === "missing"
            ? "This project does not exist. It may have been deleted with the conversations it came from."
            : "This project could not be loaded. Check your connection and reload the page."}
        </p>
        <Link href="/projects" className="text-sm underline underline-offset-4">
          All projects
        </Link>
      </div>
    );
  }

  const { project, tasks, conversations } = detail;
  const open = tasks.filter((task) => OPEN.has(task.status));
  const done = tasks.filter((task) => task.status === "completed");
  const nextSteps = open.map((task) => task.suggestedNextAction).filter(Boolean).slice(0, 5);

  async function act(task: TaskView, edit: TaskEdit) {
    if (!uid) return;
    await reviewTask(getFirebaseServices().db, uid, task.id, edit);
    await load();
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Link href="/projects" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          All projects
        </Link>
        {editing && uid ? (
          <ProjectForm
            project={project}
            onCancel={() => setEditing(false)}
            onSave={async (edit) => {
              await editProject(getFirebaseServices().db, uid, project.id, edit);
              setEditing(false);
              await load();
            }}
          />
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            {project.description ? (
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{project.description}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {project.lastActivityAt ? `Last active ${dateFormat.format(project.lastActivityAt)}` : "No activity date"}
              {project.archived ? " · Archived" : ""}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit project
              </Button>
              {uid ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await editProject(getFirebaseServices().db, uid, project.id, { archived: !project.archived });
                    await load();
                  }}
                >
                  {project.archived ? "Unarchive" : "Archive"}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </header>

      {nextSteps.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Suggested next steps</h2>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
            {nextSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Outstanding ({open.length})</h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding in this project.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {open.map((task) => (
              <TaskCard key={task.id} task={task} projects={[project]} onAction={act} />
            ))}
          </ul>
        )}
      </section>

      {project.decisions.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Decisions you made</h2>
          <ul className="flex flex-col gap-3">
            {project.decisions.map((decision, index) => {
              const url = sourceUrlFor(decision.conversationId);
              return (
                <li key={index} className="flex flex-col gap-1 border-l-2 pl-3">
                  <span className="text-sm font-medium">{decision.text}</span>
                  <q className="text-sm leading-relaxed text-muted-foreground">{decision.quote}</q>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
                    >
                      Open in Claude
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {done.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Done ({done.length})</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {done.map((task) => (
              <li key={task.id} className="px-4 py-3 text-sm text-muted-foreground line-through">
                {task.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Related conversations</h2>
        {conversations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No conversations are linked.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
                {conversation.sourceUrl ? (
                  <a
                    href={conversation.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                  >
                    <span className="truncate">{conversation.title}</span>
                    <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-sm">{conversation.title}</span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {conversation.updated ? dateFormat.format(conversation.updated) : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {project.conversationIds.length > conversations.length ? (
          <p className="text-xs text-muted-foreground">
            Showing {conversations.length} of {project.conversationIds.length}.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ProjectForm({
  project,
  onSave,
  onCancel,
}: {
  project: ProjectView;
  onSave: (edit: { name: string; description: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave({ name, description });
    } catch (caught) {
      setError(
        caught instanceof InvalidEditError
          ? caught.message
          : "Your changes could not be saved. Check your connection and try again.",
      );
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-name">Name</Label>
        <Input id="project-name" value={name} maxLength={PROJECT_NAME_MAX} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-description">Description</Label>
        <textarea
          id="project-description"
          rows={3}
          value={description}
          maxLength={PROJECT_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save project"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
