import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Loader2, Mic, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAgo } from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";

export function DialoguePanel({ onOpenVoiceLive }: { onOpenVoiceLive?: () => void }) {
  const inbox = useMissionField((s) => s.inbox);
  const now = useMissionClock();
  const issueDecree = useCletusStore((s) => s.issueDecree);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () =>
      inbox
        .filter((m) => m.from === "creator" || m.from === "agent")
        .slice()
        .sort((a, b) => a.at - b.at),
    [inbox],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || turnRunning) return;
    setDraft("");
    const res = await issueDecree(trimmed);
    if (res.ok) {
      toast.success("Orchestrator-Prime replied in Operator Bridge.");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">Operator Bridge · Principal ↔ Cletus</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            Supreme command channel &amp; live execution synthesis
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenVoiceLive ? (
            <button
              type="button"
              onClick={onOpenVoiceLive}
              className="inline-flex h-6 items-center gap-1 rounded border border-border bg-term px-2 font-mono text-[10px] text-foreground hover:bg-secondary whitespace-nowrap"
            >
              <Mic className="size-3 text-ok" />
              <span>Speak</span>
            </button>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {messages.length} msgs
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2.5 overflow-auto bg-term/60 p-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center text-center">
            <p className="text-xs text-muted-foreground">
              Send a directive below to initiate a cycle with Orchestrator-Prime.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const isCreator = m.from === "creator";
            return (
              <div
                key={m.id}
                className={cn(
                  "flex flex-col gap-1 rounded-md border px-3 py-2 text-xs",
                  isCreator
                    ? "ml-6 border-primary/30 bg-secondary/60"
                    : "mr-6 border-border bg-card",
                )}
              >
                <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span className={isCreator ? "text-warn font-medium" : "text-ok font-medium"}>
                    {isCreator ? "Operator (Principal)" : "Orchestrator-Prime"}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatAgo(m.at, now)} · {m.status}
                  </span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">{m.content}</p>
                {m.toolsUsed && m.toolsUsed.length > 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    tools: {m.toolsUsed.join(" · ")}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={handleSend}
        className="flex flex-none items-center gap-2 border-t border-border bg-card p-2.5"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message Orchestrator-Prime…"
          aria-label="Reply in Operator Bridge"
          disabled={turnRunning}
          className="h-8 flex-1 bg-term text-xs"
        />
        <Button
          type="submit"
          size="sm"
          disabled={turnRunning || !draft.trim()}
          className="h-8 whitespace-nowrap shrink-0 px-3"
        >
          {turnRunning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          <span>Send</span>
        </Button>
      </form>
    </div>
  );
}
