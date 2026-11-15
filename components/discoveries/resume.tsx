"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/api-client";
import { loadResume, reviewTask, type ResumeData } from "@/lib/discoveries/store";
import { getFirebaseServices } from "@/lib/firebase/client";
import type { ContextMessage } from "@/lib/resume/context";
import { toResumeInsights, type InsightKind, type ResumeInsights } from "@/lib/resume/insights";
import { buildResumePrompt } from "@/lib/resume/prompt";
import { cn } from "@/lib/utils";

import { LoadError, LoadingBlock, Section } from "./shared";

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

type State = { name: "loading" } | { name: "error" } | { name: "missing" } | { name: "ready"; data: ResumeData };

const KIND_LABELS: Record<InsightKind, string> = {
  progress: "Done or worked out",
  decision: "Decided",
  open_question: "Still open",
};

function Message({ message }: { message: ContextMessage }) {
  return (
    <li className={cn("flex flex-col gap-1 border-l-2 pl-3", message.isEvidence && "border-foreground")}>
      <span className="text-xs text-muted-foreground">
        {message.sender === "human" ? "You" : "Claude"}
        {message.createdAt ? ` · ${dateFormat.format(new Date(message.createdAt))}` : ""}
        {message.isEvidence ? " · where you said it" : ""}
      </span>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.text}</p>
    </li>
  );
}

export function ResumePage() {
  const { taskId } = useParams<{ taskId: string }>();
  const auth = useAuth();
  const uid = auth.status === "signedIn" ? auth.user.uid : null;
  const [state, setState] = useState<State>({ name: "loading" });
  const [insights, setInsights] = useState<ResumeInsights | null>(null);
  const [useInsights, setUseInsights] = useState(true);
  const [asking, setAsking] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "manual">("no");
  const [started, setStarted] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    if (!uid) return;
    try {
      const data = await loadResume(getFirebaseServices().db, uid, taskId);
      if (!data) return setState({ name: "missing" });
      setInsights(data.insights);
      setState({ name: "ready", data });
    } catch {
      setState({ name: "error" });
    }
  }, [uid, taskId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads remote data on mount
    void load();
  }, [load]);

  const data = state.name === "ready" ? state.data : null;
  const prompt = useMemo(
    () => (data ? buildResumePrompt(data.context, useInsights ? insights : null) : ""),
    [data, insights, useInsights],
  );

  if (state.name === "loading") return <LoadingBlock />;
  if (state.name === "error") return <LoadError what="This task" />;
  if (state.name === "missing" || !data) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Task not found</h1>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Link href="/execute" className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}>
          Back to Execution
        </Link>
      </div>
    );
  }

  const { task, context } = data;
  const sourceUrl = context.conversation?.sourceUrl ?? null;
  const hasConversation = context.messageCount > 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied("yes");
    } catch {
      // Clipboard access can be refused. Select the text and try the older
      // copy command; if that fails too, the text stays selected to copy by hand.
      promptRef.current?.focus();
      promptRef.current?.select();
      let done = false;
      try {
        done = document.execCommand("copy");
      } catch {
        done = false;
      }
      setCopied(done ? "yes" : "manual");
    }
  }

  async function askAI() {
    setAsking(true);
    setAiMessage(null);
    try {
      const response = await authFetch(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { method: "POST" });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        setAiMessage(typeof body?.error === "string" ? body.error : "That did not work. Your prompt still works without it.");
        return;
      }
      const next = toResumeInsights(body);
      setInsights(next);
      setUseInsights(true);
      setCopied("no");
      setAiMessage(
        next && next.points.length > 0
          ? null
          : "Nothing could be added: no point could be tied to the exact words of the conversation.",
      );
    } catch {
      setAiMessage("That did not work. Check your connection. Your prompt still works without it.");
    } finally {
      setAsking(false);
    }
  }

  async function markStarted() {
    if (!uid) return;
    await reviewTask(getFirebaseServices().db, uid, task.id, { status: "in_progress" });
    setStarted(true);
  }

  const points = insights?.points ?? [];

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <Link href="/execute" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          ← Execution
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{task.title}</h1>
        <p className="text-sm text-muted-foreground">
          Pick this up where you left it. Recall has gathered the context from your saved conversation and
          written a prompt you can paste into a new chat.
        </p>
      </header>

      <Section title="Where you left it">
        {context.conversation ? (
          <p className="text-sm text-muted-foreground">
            From “{context.conversation.title}”
            {context.commitment?.saidAt ? `, ${dateFormat.format(context.commitment.saidAt)}` : ""}.
          </p>
        ) : null}
        {!hasConversation ? (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            The original conversation is no longer saved in Recall, so only the quote below is available.
            {context.commitment ? ` “${context.commitment.quote}”` : ""}
          </p>
        ) : (
          <>
            {context.around.length > 0 ? (
              <ul className="flex flex-col gap-4 rounded-lg border bg-card p-5">
                {context.around.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
              </ul>
            ) : null}
            {context.ending.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {context.around.length > 0 ? "How the conversation ended" : "The end of the conversation"}
                </p>
                <ul className="flex flex-col gap-4 rounded-lg border bg-card p-5">
                  {context.ending.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </Section>

      {context.decisions.length > 0 ? (
        <Section title="Decisions on this project">
          <ul className="flex flex-col gap-3 rounded-lg border bg-card p-5">
            {context.decisions.map((decision, index) => (
              <li key={index} className="flex flex-col gap-1">
                <span className="text-sm">{decision.text}</span>
                <q className="text-xs text-muted-foreground">{decision.quote}</q>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="State of the work, found by AI">
        {points.length > 0 ? (
          <>
            <ul className="flex flex-col gap-3 rounded-lg border bg-card p-5">
              {points.map((point, index) => (
                <li key={index} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{KIND_LABELS[point.kind]}</span>
                  <span className="text-sm">{point.text}</span>
                  <q className="text-xs text-muted-foreground">{point.quote}</q>
                </li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useInsights}
                onChange={(event) => {
                  setUseInsights(event.target.checked);
                  setCopied("no");
                }}
                className="size-4 accent-foreground"
              />
              Include these points in the prompt
            </label>
          </>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Optional. Sends a redacted excerpt of this one conversation to Gemini and uses one of your daily AI
          requests. Each point is kept only if its quote appears word for word in the conversation. The prompt
          below works without it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={asking || !hasConversation} onClick={askAI}>
            {asking ? "Reading the conversation…" : points.length > 0 ? "Find again" : "Find the state of the work"}
          </Button>
        </div>
        <div aria-live="polite">
          {aiMessage ? <p className="rounded-md bg-muted px-3 py-2 text-sm">{aiMessage}</p> : null}
        </div>
      </Section>

      <Section title="Continuation prompt">
        <textarea
          ref={promptRef}
          readOnly
          aria-label="Continuation prompt"
          value={prompt}
          rows={16}
          className="w-full rounded-lg border bg-card p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={copy}>
            {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === "yes" ? "Copied" : "Copy prompt"}
          </Button>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Open the original chat
              <ExternalLink aria-hidden="true" />
            </a>
          ) : null}
          <a
            href="https://claude.ai/new"
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Open a new chat
            <ExternalLink aria-hidden="true" />
          </a>
          {task.status === "approved" && !started ? (
            <Button size="sm" variant="ghost" onClick={markStarted}>
              Mark as in progress
            </Button>
          ) : null}
        </div>
        <div aria-live="polite" className="text-sm">
          {copied === "yes" ? <p>Copied. Paste it into a chat to continue.</p> : null}
          {copied === "manual" ? <p>Your browser blocked copying. The prompt is selected: press Ctrl+C or ⌘C.</p> : null}
          {started ? <p>Marked as in progress.</p> : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Recall cannot open or continue a chat for you. The links open Claude in a new tab, where you are
          signed in yourself; paste the prompt there. Read it first: it contains parts of your conversation
          as you wrote them, with secrets, email addresses and long numbers replaced.
        </p>
      </Section>
    </div>
  );
}
