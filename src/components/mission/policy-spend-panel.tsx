import { useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { formatAgo, formatCents, formatCredits, heartbeatPct } from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { SpendBars } from "./spend-bars";
import { StatusDot } from "./status";

const CREDIT_PRESETS: Array<{ label: string; cents: number }> = [
  { label: "High (600 cr)", cents: 60_000 },
  { label: "Normal (184.20 cr)", cents: 18_420 },
  { label: "Low Compute (22 cr)", cents: 2_200 },
  { label: "Critical (6 cr)", cents: 600 },
  { label: "Dead (0 cr)", cents: 0 },
];

export function PolicySpendPanel() {
  const vitals = useMissionField((s) => s.vitals);
  const entelechy = useMissionField((s) => s.entelechy);
  const spend24h = useMissionField((s) => s.spend24h);
  const spendByModel = useMissionField((s) => s.spendByModel);
  const denials = useMissionField((s) => s.denials);
  const heartbeats = useMissionField((s) => s.heartbeats);
  const skills = useMissionField((s) => s.skills);
  const now = useMissionClock();
  const toggleSkill = useCletusStore((s) => s.toggleSkill);
  const setSimulatedCredits = useCletusStore((s) => s.setSimulatedCredits);
  const runHeartbeatSweep = useCletusStore((s) => s.runHeartbeatSweep);
  const loading = useCletusStore((s) => s.loading);

  const [customCredits, setCustomCredits] = useState("184.20");
  const [sweeping, setSweeping] = useState(false);

  async function handleRunSweep() {
    setSweeping(true);
    try {
      const res = await runHeartbeatSweep(true);
      if (res.ok) {
        toast.success(
          `Heartbeat sweep executed ${res.executed?.length ?? 0} cadence(s)${
            res.repairedTotal ? ` · ${res.repairedTotal} repaired` : ""
          }.`,
        );
      } else if (res.error) {
        toast.error(res.error);
      }
    } finally {
      setSweeping(false);
    }
  }

  const total24h = spend24h.reduce((sum, p) => sum + p.cents, 0);
  const totalCalls = spendByModel.reduce((sum, m) => sum + m.calls, 0);
  const maxModel = Math.max(...spendByModel.map((m) => m.cents), 1);

  async function applyCreditsCents(cents: number) {
    await setSimulatedCredits(cents);
    toast.success(`Credit Governor calibrated to ${(cents / 100).toFixed(2)} cr.`);
  }

  async function handleCustomCredits(e: FormEvent) {
    e.preventDefault();
    const num = Number(customCredits);
    if (!Number.isFinite(num) || num < 0) return;
    await applyCreditsCents(Math.round(num * 100));
  }

  return (
    <div className="flex h-full min-h-0 flex-col divide-y divide-border overflow-auto bg-term/60 text-xs">
      {/* Credit Depletion Governor (explicitly authorized behavioral stress-test control) */}
      <section className="space-y-2 bg-card/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Credit Depletion Governor
          </p>
          <span className="font-mono text-[11px] text-warn tabular-nums">
            tier={vitals.tier}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Adjust remaining credit balance to observe real PolicyEngine throttling, round compression, and autonomous halt transitions under fund depletion.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {CREDIT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={loading}
              onClick={() => void applyCreditsCents(preset.cents)}
              className="h-6 rounded border border-border bg-term px-2 font-mono text-[10px] text-foreground hover:bg-secondary whitespace-nowrap"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <form onSubmit={handleCustomCredits} className="flex items-center gap-1.5">
          <Input
            type="number"
            step="0.5"
            min="0"
            value={customCredits}
            onChange={(e) => setCustomCredits(e.target.value)}
            aria-label="Set remaining credits in cr"
            className="h-7 w-28 bg-term font-mono text-xs tabular-nums"
          />
          <Button type="submit" variant="outline" size="sm" disabled={loading} className="h-7 text-[11px]">
            Set Credits (cr)
          </Button>
        </form>
      </section>

      {/* Entelechy Posture */}
      <section className="space-y-1.5 bg-card/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Entelechy Posture
          </p>
          <span className="font-mono text-[11px] text-ok tabular-nums">
            {entelechy.riskPosture} · conf {entelechy.confidence.toFixed(2)}
          </span>
        </div>
        <p className="text-sm font-medium text-foreground">{entelechy.mission}</p>
        <p className="text-muted-foreground">{entelechy.recommendation}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          avoid: {entelechy.avoid.join(" · ")}
        </p>
      </section>

      {/* Treasury & 24h Spend */}
      <section className="space-y-3 p-3">
        <div className="flex items-baseline justify-between">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Treasury &amp; 24h Compute Spend
          </p>
          <span className="font-mono text-[11px] text-foreground tabular-nums">
            {formatCents(total24h)} · {totalCalls} calls
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
          <div className="rounded border border-border bg-card px-2.5 py-1.5">
            <span className="block text-[10px] text-muted-foreground">Credits</span>
            <span className="text-foreground font-medium">{formatCredits(vitals.creditsCents)}</span>
          </div>
          <div className="rounded border border-border bg-card px-2.5 py-1.5">
            <span className="block text-[10px] text-muted-foreground">Solana USDC</span>
            <span className="text-foreground font-medium">{formatCents(vitals.usdcCents)}</span>
          </div>
          <div className="rounded border border-border bg-card px-2.5 py-1.5">
            <span className="block text-[10px] text-muted-foreground">Reserve Floor</span>
            <span className="text-warn font-medium">{formatCredits(vitals.reserveCents)}</span>
          </div>
        </div>

        {spend24h.length > 0 ? <SpendBars data={spend24h} heightClass="h-20" /> : null}

        <div className="space-y-1.5">
          {spendByModel.map((m) => (
            <div key={m.model}>
              <div className="flex items-baseline justify-between font-mono text-[11px]">
                <span className="text-foreground">
                  {m.model} <span className="text-muted-foreground">({m.calls})</span>
                </span>
                <span className="tabular-nums text-muted-foreground">{formatCents(m.cents)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${Math.max(4, Math.round((m.cents / maxModel) * 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* PolicyEngine Denials */}
      <section className="space-y-1.5 p-3">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            PolicyEngine Denials ({denials.length})
          </p>
          <span className="font-mono text-[10px] text-muted-foreground">First denial wins</span>
        </div>
        {denials.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">No policy denials recorded.</p>
        ) : (
          <ul className="space-y-1 font-mono text-[11px]">
            {denials.slice(0, 6).map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-2 text-warn">
                <span className="min-w-0">
                  {d.tool}: <span className="text-foreground/90">{d.rule}</span>
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatAgo(d.at, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Heartbeats */}
      <section className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Heartbeat Cadences ({heartbeats.filter((h) => h.ok).length}/{heartbeats.length} ok)
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || sweeping}
            onClick={() => void handleRunSweep()}
            className="h-6 px-2 text-[10px] whitespace-nowrap shrink-0"
          >
            <RefreshCw className={cn("size-3", sweeping && "animate-spin")} />
            <span>{sweeping ? "Sweeping" : "Run Sweep"}</span>
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {heartbeats.map((h) => (
            <div key={h.name} className="rounded border border-border bg-card px-2.5 py-2 space-y-1">
              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
                  <StatusDot tone={!h.ok ? "crit" : h.due ? "warn" : "ok"} />
                  <span className="truncate">{h.name}</span>
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {h.cadence} · {formatAgo(now - h.lastAgoMs, now)}
                </span>
              </div>
              <Progress value={heartbeatPct(h.lastAgoMs, h.cadence)} />
              <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                <span className="truncate" title={h.summary}>
                  {h.summary ?? "Ready"}
                </span>
                <span className="shrink-0">
                  {h.durationMs ? `${h.durationMs}ms` : ""}
                  {h.repairedCount ? ` · +${h.repairedCount} fix` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Skills Gating */}
      <section className="space-y-1.5 p-3">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Skills Gating
          </p>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {skills.filter((s) => s.enabled).length}/{skills.length} enabled
          </span>
        </div>
        <div className="divide-y divide-border/60 rounded border border-border bg-card">
          {skills.map((sk) => (
            <button
              key={sk.name}
              type="button"
              disabled={loading}
              onClick={() => void toggleSkill(sk.name)}
              className="flex w-full items-start justify-between gap-3 px-2.5 py-2 text-left transition-colors hover:bg-secondary/40"
            >
              <div className="min-w-0">
                <p className={cn("font-mono text-xs", sk.enabled ? "text-foreground" : "text-muted-foreground")}>
                  {sk.name}
                </p>
                <p className="text-[11px] text-muted-foreground">{sk.summary}</p>
              </div>
              <span
                className={cn(
                  "mt-0.5 shrink-0 font-mono text-[10px] uppercase",
                  sk.enabled ? "text-ok" : "text-muted-foreground",
                )}
              >
                {sk.enabled ? (sk.autoActivate ? "auto" : "on") : "off"}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
