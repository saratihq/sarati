"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowUp, Check, CircleDot, Database, MessageSquare, Paperclip, Plus, Table2, X } from "lucide-react";
import { useComposer, type ThreadEntry } from "@/store/useComposer";
import { useWorkflow } from "@/store/useWorkflow";
import { Button } from "@/components/ui/button";
import ConnectAppButton from "./ConnectAppButton";
import { SaratiLoader } from "./SaratiLogo";

/** The composer thread — one component in two shapes: the editor's bottom bar, or a `panel` column. */
export default function ComposerBar({
  workflowId,
  panel = false,
}: {
  workflowId?: string;
  panel?: boolean;
}) {
  const thread = useComposer((s) => s.thread);
  const questions = useComposer((s) => s.questions);
  const streaming = useComposer((s) => s.streaming);
  const failure = useComposer((s) => s.failure);
  const send = useComposer((s) => s.send);
  const attach = useComposer((s) => s.attach);
  const reset = useComposer((s) => s.reset);
  const offerPending = useComposer((s) => s.offerPending);
  const accepting = useComposer((s) => s.accepting);
  const acceptOffer = useComposer((s) => s.acceptOffer);
  const connectionNeeds = useComposer((s) => s.connectionNeeds);
  const clearThread = useComposer((s) => s.clearThread);
  const [confirmClear, setConfirmClear] = useState(false);

  // One chip per app, however many steps wait on it (a connection is per-provider).
  const neededProviders = Array.from(
    new Map(Object.values(connectionNeeds).map((n) => [n.provider, n])).values(),
  );

  const [input, setInput] = useState("");
  // A picked text file rides along with the next message; text-only and size-capped.
  const [attachment, setAttachment] = useState<{ name: string; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const ATTACH_MAX = 256 * 1024; // 256 KB of text
  const onFilePick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked
    if (!file) return;
    if (file.size > ATTACH_MAX) {
      setAttachment({ name: file.name, text: "" }); // shown as an over-size note
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAttachment({ name: file.name, text: String(reader.result ?? "") });
    reader.readAsText(file);
  };

  // A refresh mid-conversation reattaches to the stored session and replays the thread.
  useEffect(() => {
    if (useComposer.getState().thread.length === 0) void attach(workflowId);
    return () => {
      reset();
    };
  }, [attach, reset, workflowId]);

  // Dev-only hooks so a proof script can drive co-editing without the inspector UI.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as Record<string, unknown>).__composerTestHooks = {
      updateIrNode: (nodeId: string, patch: Record<string, unknown>) =>
        useWorkflow.getState().updateIrNode(nodeId, patch),
      // The exact callback ConnectAppButton fires on a completed sign-in.
      notifyConnected: (provider: string, providerLabel: string) =>
        useComposer.getState().notifyConnected(provider, providerLabel),
      acceptOffer: (choice: "live" | "draft" | "tweak", wfId?: string) =>
        useComposer.getState().acceptOffer(choice, wfId),
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__composerTestHooks;
    };
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [thread, questions, streaming]);

  // A canvas badge tap (WorkflowNode, outside this tree) lands its text in the input via the store.
  useEffect(
    () =>
      useComposer.subscribe((state, prev) => {
        if (state.prefill !== null && state.prefill !== prev.prefill) {
          const text = useComposer.getState().consumePrefill();
          if (text !== null) {
            setInput(text);
            inputRef.current?.focus();
          }
        }
      }),
    [],
  );

  const submit = () => {
    const message = input.trim();
    if ((!message && !attachment) || streaming) return;
    const full =
      attachment && attachment.text
        ? `${message ? message + "\n\n" : ""}Attached file "${attachment.name}":\n${attachment.text}`
        : message;
    setInput("");
    setAttachment(null);
    void send(full, workflowId);
  };

  const hasThread = thread.length > 0 || failure;

  return (
    <div
      className={
        panel
          ? "flex-1 min-h-0 px-4 py-3 flex flex-col gap-2"
          : "shrink-0 rounded-lg px-4 py-3 flex flex-col gap-2"
      }
      style={
        panel
          ? undefined
          : {
              border: "1px solid var(--orchestr-line)",
              background: "var(--orchestr-surface-raised, var(--orchestr-surface))",
            }
      }
    >
      {(hasThread || panel) && (
        <div
          ref={threadRef}
          className={
            panel
              ? "flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto pr-1"
              : "flex flex-col gap-2.5 max-h-72 overflow-y-auto pr-1"
          }
          aria-live="polite"
        >
          {panel && !hasThread && (
            <>
              <p className="text-[12.5px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Tell me what you want to automate — I&apos;ll build it on the canvas as we talk, ask when I need
                something, and test it with you before it goes live.
              </p>
              {/* Suggested workflows; a click fills the full prompt into the input. */}
              <div className="flex-1 flex flex-col justify-center gap-2">
                {[
                  { Icon: MessageSquare, title: "Route form replies to Slack", desc: "New form response → posted to a channel", prompt: "When a form is submitted, post the answers to Slack" },
                  { Icon: Table2, title: "Summarize new spreadsheet rows", desc: "A digest when fresh rows land", prompt: "Email me a summary when a new row lands in my spreadsheet" },
                  { Icon: CircleDot, title: "Triage new GitHub issues", desc: "New issue → labelled and logged to a sheet", prompt: "Every morning, save yesterday's new GitHub issues to a sheet" },
                  { Icon: Database, title: "Weekly report from my database", desc: "Every Monday: query → emailed summary", prompt: "Every Monday, email me a report from my database" },
                ].map(({ Icon, title, desc, prompt }) => (
                  <button
                    key={title}
                    type="button"
                    onClick={() => {
                      setInput(prompt);
                      inputRef.current?.focus();
                    }}
                    className="flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5 cursor-pointer transition-colors hover:brightness-125"
                    style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
                    data-testid="composer-sample"
                  >
                    <Icon size={16} className="shrink-0" style={{ color: "var(--orchestr-ink-muted)" }} />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium truncate" style={{ color: "var(--orchestr-ink)" }}>
                        {title}
                      </span>
                      <span className="block text-[11px] truncate" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        {desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {thread.map((entry) => (
            <ThreadItem key={entry.id} entry={entry} workflowId={workflowId} />
          ))}
          {streaming && (
            <span className="inline-flex items-center gap-1.5">
              <SaratiLoader size={12} />
            </span>
          )}
          {failure && (
            <p className="text-[12.5px] m-0" style={{ color: "var(--orchestr-danger)" }}>
              {failure}
            </p>
          )}
        </div>
      )}
      {neededProviders.length > 0 && !streaming && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="composer-connects">
          {neededProviders.map((need) => (
            <ComposerConnectChip key={need.provider} provider={need.provider} providerLabel={need.providerLabel} />
          ))}
        </div>
      )}
      {offerPending && !streaming && (
        <div className="flex items-center gap-2" data-testid="composer-offer">
          {/* The composer commits versions but never moves a live pointer (ADR 0032 B3). */}
          <Button size="sm" disabled={accepting} onClick={() => void acceptOffer("live", workflowId)} data-testid="offer-save-live">
            {accepting ? <SaratiLoader size={13} /> : null} {workflowId ? "Save" : "Save and turn on"}
          </Button>
          <Button size="sm" variant="secondary" disabled={accepting} onClick={() => void acceptOffer("draft", workflowId)} data-testid="offer-save-draft">
            Save as a draft
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={accepting}
            onClick={() => {
              void acceptOffer("tweak", workflowId);
              inputRef.current?.focus();
            }}
            data-testid="offer-tweak"
          >
            Keep tweaking
          </Button>
        </div>
      )}
      {panel && hasThread && !streaming && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              setConfirmClear(false);
              void clearThread(workflowId);
            }}
            className="text-[11px] bg-transparent border-none p-0 cursor-pointer hover:underline"
            style={{ color: confirmClear ? "var(--orchestr-danger)" : "var(--orchestr-ink-subtle)" }}
            data-testid="composer-clear"
          >
            {confirmClear ? "Clear this conversation? Click again" : "clear conversation"}
          </button>
        </div>
      )}
      {/* The compose box: a stacked field in panel mode, a single inline row in the editor's bar. */}
      <form
        className={
          panel
            ? "flex flex-col gap-1 rounded-xl px-3 pt-2 pb-1.5"
            : "flex items-center gap-2"
        }
        style={
          panel
            ? // Fill, not a border: the panel card is already bordered.
              { background: "var(--orchestr-surface-raised, var(--orchestr-surface))" }
            : undefined
        }
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input ref={fileInputRef} type="file" onChange={onFilePick} className="hidden" accept=".txt,.csv,.tsv,.json,.md,.yaml,.yml,.xml,.log" />
        {attachment && (
          <div
            className="flex items-center gap-1.5 self-start max-w-full rounded-lg px-2 py-1 text-[11px]"
            style={{ background: "var(--orchestr-surface-raised, var(--orchestr-surface))", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink-muted)" }}
          >
            <Paperclip size={11} className="shrink-0" />
            <span className="truncate">{attachment.name}</span>
            {!attachment.text && <span style={{ color: "var(--orchestr-danger)" }}>· too large (max 256 KB)</span>}
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="Remove attachment"
              className="bg-transparent border-none cursor-pointer p-0 shrink-0"
              style={{ color: "var(--orchestr-ink-subtle)" }}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {panel ? (
          <>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe a workflow to build…"
              disabled={streaming}
              className="w-full bg-transparent outline-none text-[13px] px-1 disabled:opacity-60"
              // Inline outline:none is required to beat the unlayered global `:focus-visible` ring.
              style={{ color: "var(--orchestr-ink)", outline: "none" }}
              aria-label="Composer message"
            />
            <div className="flex items-center justify-between">
              <AttachButton onClick={() => fileInputRef.current?.click()} disabled={streaming} />
              <Button type="submit" size="sm" disabled={streaming || (input.trim().length === 0 && !attachment)}>
                {streaming ? <SaratiLoader size={13} /> : <ArrowUp size={14} />}
              </Button>
            </div>
          </>
        ) : (
          <>
            <AttachButton onClick={() => fileInputRef.current?.click()} disabled={streaming} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe a workflow to build…"
              disabled={streaming}
              className="flex-1 bg-transparent outline-none text-[13px] disabled:opacity-60"
              // Same focus-ring suppression as the panel input above.
              style={{ color: "var(--orchestr-ink)", outline: "none" }}
              aria-label="Composer message"
            />
            <Button type="submit" size="sm" disabled={streaming || (input.trim().length === 0 && !attachment)}>
              {streaming ? <SaratiLoader size={13} /> : <ArrowUp size={14} />}
            </Button>
          </>
        )}
      </form>
    </div>
  );
}

/** The `+` file-attach control — same in the boxed panel and the inline bar. */
function AttachButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Attach a file"
      title="Attach a text file (CSV, JSON…)"
      className="shrink-0 flex items-center justify-center rounded-lg cursor-pointer disabled:opacity-60 transition-colors hover:bg-[var(--orchestr-accent-tint)]"
      style={{ width: 28, height: 28, color: "var(--orchestr-ink-subtle)" }}
    >
      <Plus size={16} />
    </button>
  );
}

function ThreadItem({ entry, workflowId }: { entry: ThreadEntry; workflowId?: string }) {
  if (entry.kind === "user") {
    return (
      <p
        className="text-[12.5px] m-0 self-end max-w-[80%] rounded-lg px-2.5 py-1.5"
        style={{ color: "var(--orchestr-ink)", background: "var(--orchestr-surface-card)" }}
      >
        {entry.text}
      </p>
    );
  }
  if (entry.kind === "text") {
    return (
      <p
        className="text-[12.5px] m-0 leading-relaxed whitespace-pre-wrap"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        {/* Plain prose only: the model's markdown bold would render as literal asterisks. */}
        {entry.text.replace(/\*\*/g, "")}
      </p>
    );
  }
  if (entry.kind === "brief") {
    return <BriefCard entry={entry} workflowId={workflowId} />;
  }
  if (entry.kind === "run") {
    return (
      <p
        className="text-[12px] m-0 inline-flex items-center gap-1.5"
        style={{ color: "var(--orchestr-ink-muted)" }}
        data-testid="run-line"
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: entry.status === "passed" ? "var(--orchestr-success)" : "var(--orchestr-danger)",
          }}
        />
        {entry.text}
      </p>
    );
  }
  return <QuestionChip questionId={entry.questionId} />;
}

function BriefCard({
  entry,
  workflowId,
}: {
  entry: Extract<ThreadEntry, { kind: "brief" }>;
  workflowId?: string;
}) {
  const streaming = useComposer((s) => s.streaming);
  const send = useComposer((s) => s.send);
  const requestPrefill = useComposer((s) => s.requestPrefill);
  const isLatestBrief = useComposer((s) => {
    for (let i = s.thread.length - 1; i >= 0; i -= 1) {
      const e = s.thread[i]!;
      if (e.kind === "brief") return e.id === entry.id;
    }
    return false;
  });
  const { brief } = entry;

  return (
    <div
      className="rounded-lg px-3 py-2.5 flex flex-col gap-1.5"
      style={{ border: "1px solid var(--orchestr-line-strong)", background: "var(--orchestr-surface-card)" }}
      data-testid="composer-brief"
    >
      <p className="text-[12.5px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
        {brief.goal}
      </p>
      <p className="text-[12px] m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
        Starts when: {brief.trigger}
      </p>
      <ol className="text-[12px] m-0 pl-4 flex flex-col gap-0.5" style={{ color: "var(--orchestr-ink-muted)" }}>
        {brief.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {brief.needs.length > 0 && (
        <p className="text-[12px] m-0" style={{ color: "var(--orchestr-warning)" }}>
          Still needs: {brief.needs.join(" · ")}
        </p>
      )}
      {isLatestBrief && !streaming && (
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={() => void send("Build it", workflowId)} data-testid="brief-build">
            Build it
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => requestPrefill("Change the plan: ")}
            data-testid="brief-change"
          >
            Change something
          </Button>
        </div>
      )}
    </div>
  );
}

/** A clarifying question as tappable chips; the thread and the canvas copy share one answer path. */
export function QuestionChip({ questionId, compact }: { questionId: string; compact?: boolean }) {
  const question = useComposer((s) => s.questions[questionId]);
  const answer = useComposer((s) => s.answer);
  const [custom, setCustom] = useState("");
  if (!question) return null;

  return (
    <div
      className="rounded-lg px-3 py-2 flex flex-col gap-1.5"
      style={{
        border: "1px solid var(--orchestr-warning)",
        background: "var(--orchestr-surface-card)",
      }}
      data-testid={compact ? "node-question" : "composer-question"}
    >
      <p className="text-[12px] m-0 font-medium" style={{ color: "var(--orchestr-ink)" }}>
        {question.question}
      </p>
      {question.answer !== undefined ? (
        <p
          className="text-[12px] m-0 inline-flex items-center gap-1"
          style={{ color: "var(--orchestr-ink-muted)" }}
        >
          <Check size={12} /> {question.answer}
          {question.timedOut ? " (went ahead with this)" : ""}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => (
              <button
                key={option}
                type="button"
                disabled={question.submitting}
                onClick={() => void answer(question.questionId, option)}
                className="text-[12px] rounded-full px-2.5 py-1 disabled:opacity-60 cursor-pointer"
                style={{
                  border: "1px solid var(--orchestr-line-strong)",
                  color: "var(--orchestr-ink)",
                  background: "transparent",
                }}
                data-testid="question-option"
              >
                {option}
              </button>
            ))}
          </div>
          {!compact && (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim()) void answer(question.questionId, custom);
                setCustom("");
              }}
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Or type an answer…"
                disabled={question.submitting}
                className="flex-1 bg-transparent outline-none text-[12px] disabled:opacity-60"
                style={{ color: "var(--orchestr-ink)" }}
                aria-label="Custom answer"
              />
              {question.submitting && <SaratiLoader size={11} />}
            </form>
          )}
        </>
      )}
    </div>
  );
}

/** A Connect chip; success clears the standing asks for that app and has the agent re-test the step. */
export function ComposerConnectChip({
  provider,
  providerLabel,
  compact,
}: {
  provider: string;
  providerLabel: string;
  compact?: boolean;
}) {
  const notifyConnected = useComposer((s) => s.notifyConnected);
  return (
    <ConnectAppButton
      app={provider}
      appName={providerLabel}
      size="sm"
      variant={compact ? "secondary" : "default"}
      className={compact ? "text-[11px] h-6 px-2" : undefined}
      onConnected={() => void notifyConnected(provider, providerLabel)}
      data-testid={compact ? "node-connect" : "composer-connect"}
    />
  );
}
