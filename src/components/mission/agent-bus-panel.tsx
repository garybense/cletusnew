import { useState, type FormEvent } from "react";
import { ArrowRight, Loader2, Play, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAgo } from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import type { AgentMessageType } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";

export function AgentBusPanel() {
  const agentMessages = useMissionField((s) => s.agentMessages);
  const agents = useMissionField((s) => s.children);
  const now = useMissionClock();
  const sendAgentMessage = useCletusStore((s) => s.sendAgentMessage);
  const runTurn = useCletusStore((s) => s.runTurn);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [fromAgent, setFromAgent] = useState("Orchestrator-Prime");
  const [toAgent, setToAgent] = useState("Research-Specialist-01");
  const [messageType, setMessageType] = useState<AgentMessageType>("handoff");
  const [subject, setSubject] = useState("");
  const [payloadStr, setPayloadStr] = useState('{"priority":"high"}');

  const pendingCount = agentMessages.filter((m) => m.status === "pending").length;

  async function handleDispatch(e: FormEvent, executeNow: boolean) {
    e.preventDefault();
    if (!subject.trim() || turnRunning) return;
    const res = await sendAgentMessage({
      fromAgent,
      toAgent,
      messageType,
      subject: subject.trim(),
      payloadStr: payloadStr.trim() || "{}",
      executeHandoffTurn: executeNow,
    });
    if (res.ok) {
      toast.success(
        executeNow
          ? `Handoff sent and ${toAgent} completed discrete turn.`
          : `Message queued for ${toAgent}.`,
      );
      setSubject("");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  async function handleRunTarget(agentName: string) {
    const res = await runTurn({ targetAgentName: agentName });
    if (res.ok) {
      toast.success(`${res.actorName ?? agentName} executed discrete handoff turn.`);
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-xs font-medium text-foreground">Inter-Agent Communication Bus</p>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {pendingCount} pending handoffs · {agentMessages.length} total messages
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => void handleDispatch(e, false)}
        className="flex-none space-y-2 border-b border-border bg-secondary/35 p-2.5 text-xs"
      >
        <div className="grid grid-cols-3 gap-1.5">
          <select
            aria-label="From agent"
            value={fromAgent}
            onChange={(e) => setFromAgent(e.target.value)}
            className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label="To agent"
            value={toAgent}
            onChange={(e) => setToAgent(e.target.value)}
            className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.name}>
                → {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Message type"
            value={messageType}
            onChange={(e) => setMessageType(e.target.value as AgentMessageType)}
            className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
          >
            <option value="handoff">handoff</option>
            <option value="plan_proposal">plan_proposal</option>
            <option value="critique">critique</option>
            <option value="tool_share">tool_share</option>
            <option value="status">status</option>
          </select>
        </div>

        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Handoff subject (e.g. Research arXiv MAS memory bounds)…"
          className="h-7 bg-term font-mono text-[11px]"
          required
        />

        <div className="flex items-center gap-1.5">
          <Input
            value={payloadStr}
            onChange={(e) => setPayloadStr(e.target.value)}
            placeholder='{"taskId":"..."}'
            className="h-7 flex-1 bg-term font-mono text-[11px]"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={turnRunning || !subject.trim()}
            className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
          >
            <Send className="size-3" />
            <span>Queue</span>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={turnRunning || !subject.trim()}
            onClick={(e) => void handleDispatch(e, true)}
            className="h-7 px-2.5 text-[11px] whitespace-nowrap shrink-0"
          >
            {turnRunning ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            <span>Send &amp; Run</span>
          </Button>
        </div>
      </form>

      <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto bg-term/60">
        {agentMessages.length === 0 ? (
          <p className="py-8 text-center font-mono text-xs text-muted-foreground">
            No inter-agent messages recorded yet.
          </p>
        ) : (
          agentMessages.map((msg) => (
            <div key={msg.id} className="space-y-1 px-3 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <div className="flex min-w-0 items-center gap-1.5 truncate">
                  <span className="text-foreground font-medium truncate">{msg.fromAgent}</span>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                  <span className="text-ok font-medium truncate">{msg.toAgent}</span>
                  <span className="text-muted-foreground">· {msg.messageType}</span>
                </div>
                <span
                  className={cn(
                    "shrink-0 uppercase text-[10px] tabular-nums",
                    msg.status === "pending" ? "text-warn" : "text-muted-foreground",
                  )}
                >
                  {msg.status} · {formatAgo(msg.createdAt, now)}
                </span>
              </div>
              <p className="font-medium text-foreground">{msg.subject}</p>
              <pre className="overflow-x-auto rounded border border-border/60 bg-card/70 px-2 py-1 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap">
                {JSON.stringify(msg.payload)}
              </pre>
              {msg.status === "pending" ? (
                <div className="flex justify-end pt-0.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={turnRunning}
                    onClick={() => void handleRunTarget(msg.toAgent)}
                    className="h-6 px-2 text-[10px] whitespace-nowrap"
                  >
                    <Play className="size-2.5" />
                    <span>Run {msg.toAgent} Turn</span>
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
