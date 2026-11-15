"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CATEGORY_LABELS,
  DESCRIPTION_MAX,
  InvalidEditError,
  PRIORITY_LABELS,
  sourceUrlFor,
  TITLE_MAX,
  type ProjectView,
  type TaskEdit,
  type TaskView,
} from "@/lib/discoveries/model";
import { PRIORITIES, type Priority } from "@/lib/domain/discovery";

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const fieldClass =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function toDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type TaskAction = (task: TaskView, edit: TaskEdit, label: string) => Promise<void>;

export function TaskCard({
  task,
  projects,
  onAction,
}: {
  task: TaskView;
  projects: ProjectView[];
  onAction: TaskAction;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const project = projects.find((candidate) => candidate.id === task.projectId);

  async function act(edit: TaskEdit, label: string) {
    setBusy(true);
    try {
      await onAction(task, edit, label);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-card p-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-base leading-snug font-semibold">{task.title}</h3>
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{CATEGORY_LABELS[task.category] ?? "Discovery"}</span>
          <span aria-hidden="true">·</span>
          <span>{PRIORITY_LABELS[task.priority]} priority</span>
          {project ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{project.name}</span>
            </>
          ) : null}
          {task.status === "in_progress" ? (
            <>
              <span aria-hidden="true">·</span>
              <span>In progress</span>
            </>
          ) : null}
          {task.remindOn ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Reminder {dateFormat.format(task.remindOn)}</span>
            </>
          ) : null}
          {task.dueDate ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Due {task.dueDate}, as you stated</span>
            </>
          ) : null}
        </p>
        {task.description ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{task.description}</p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-3">
        {task.evidence.map((evidence, index) => {
          const url = sourceUrlFor(evidence.conversationId);
          return (
            <li key={index} className="flex flex-col gap-1 border-l-2 pl-3">
              <q className="text-sm leading-relaxed">{evidence.quote}</q>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>
                  {evidence.kind === "completion" ? "Later, you said" : "You said"}
                  {evidence.messageAt ? ` on ${dateFormat.format(evidence.messageAt)}` : ""}
                </span>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    Open in Claude
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {task.suggestedNextAction ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Suggested next step: </span>
          {task.suggestedNextAction}
        </p>
      ) : null}

      {task.completionSuggested && task.status !== "completed" ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          A later message suggests this is already done. Recall has not changed it for you.
        </p>
      ) : null}
      {task.needsAttention && task.status === "awaiting_review" ? (
        <p className="text-xs text-muted-foreground">
          Recall is less sure this was something you meant to do. Check the quote.
        </p>
      ) : null}

      {editing ? (
        <EditForm
          task={task}
          projects={projects}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            await onAction(task, edit, "Saved changes");
            setEditing(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {task.status === "awaiting_review" ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => act({ status: "approved" }, "Approved")}>
                Approve
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ status: "dismissed" }, "Dismissed")}>
                Dismiss
              </Button>
            </>
          ) : null}
          {task.status === "approved" || task.status === "in_progress" ? (
            <Link href={`/resume/${task.id}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Resume
            </Link>
          ) : null}
          {task.status === "approved" ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => act({ status: "in_progress" }, "Started")}>
                Start
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ status: "awaiting_review" }, "Moved back to review")}>
                Move back to review
              </Button>
            </>
          ) : null}
          {task.status === "in_progress" ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => act({ status: "completed" }, "Marked as done")}>
                Mark as done
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ status: "approved" }, "Paused")}>
                Pause
              </Button>
            </>
          ) : null}
          {task.status === "dismissed" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ status: "awaiting_review" }, "Restored")}>
              Restore
            </Button>
          ) : null}
          {task.status === "completed" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ status: "awaiting_review" }, "Reopened")}>
              Reopen
            </Button>
          ) : null}
          {task.status === "awaiting_review" || task.status === "approved" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ status: "completed" }, "Marked as done")}>
              Mark as done
            </Button>
          ) : null}
          {task.status !== "dismissed" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function EditForm({
  task,
  projects,
  onSave,
  onCancel,
}: {
  task: TaskView;
  projects: ProjectView[];
  onSave: (edit: TaskEdit) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [projectId, setProjectId] = useState(task.projectId ?? "");
  const [remindOn, setRemindOn] = useState(task.remindOn ? toDateInput(task.remindOn) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave({
        title,
        description,
        priority,
        projectId: projectId || null,
        // Midday local time, so the date does not shift across time zones.
        remindOn: remindOn ? new Date(`${remindOn}T12:00:00`) : null,
      });
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
    <form onSubmit={submit} className="flex flex-col gap-4 border-t pt-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={title}
          maxLength={TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-description`}>Notes</Label>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={description}
          maxLength={DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          className={fieldClass}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-priority`}>Priority</Label>
          <select
            id={`${id}-priority`}
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
            className={fieldClass}
          >
            {PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {PRIORITY_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-project`}>Project</Label>
          <select
            id={`${id}-project`}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className={fieldClass}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:max-w-[calc(50%-0.5rem)]">
        <Label htmlFor={`${id}-remind`}>Remind me on</Label>
        <input
          id={`${id}-remind`}
          type="date"
          value={remindOn}
          onChange={(event) => setRemindOn(event.target.value)}
          className={fieldClass}
        />
        <p className="text-xs text-muted-foreground">
          Shown on your dashboard from that day. Recall does not send emails or notifications.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
