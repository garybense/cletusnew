import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  AudioLines,
  Check,
  Database,
  Download,
  ExternalLink,
  Globe,
  Layers,
  Loader2,
  Play,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDomainPack, listDomainPacks, type RankedMemoryResult } from "@/lib/cletus/domains";
import { formatAgo } from "@/lib/cletus/format";
import { LIVE_VOICE_PRESETS } from "@/lib/cletus/nvidia-inference";
import {
  analyzeUrlContextServer,
  generateAudioBriefingServer,
  runDomainConnectorServer,
  searchDomainMemoriesServer,
} from "@/lib/cletus/server";
import { useCletusStore } from "@/lib/cletus/store";
import type { DomainId, JsonObject } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { D3SpeechWaveform, ensureMediaElementAnalyser } from "./d3-speech-waveform";
import { useMissionClock, useMissionField } from "./snapshot-context";

type StudioSubView = "packs" | "memory" | "briefing";

export function DomainStudioPanel() {
  const activeDomain = useMissionField((s) => s.activeDomain);
  const domainMemories = useMissionField((s) => s.domainMemories);
  const audioBriefings = useMissionField((s) => s.audioBriefings);
  const now = useMissionClock();

  const activateDomainPack = useCletusStore((s) => s.activateDomainPack);
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const loading = useCletusStore((s) => s.loading);

  const packs = listDomainPacks();
  const [subView, setSubView] = useState<StudioSubView>("packs");
  const [inspectedDomain, setInspectedDomain] = useState<DomainId>(activeDomain);
  const [customFocus, setCustomFocus] = useState("");

  // Connector runner state
  const viewedPack = getDomainPack(inspectedDomain);
  const [selectedPresetIdx, setSelectedPresetIdx] = useState(0);
  const currentPreset = viewedPack.connectors[selectedPresetIdx] ?? viewedPack.connectors[0]!;
  const [connectorTool, setConnectorTool] = useState(currentPreset.toolName);
  const [connectorArgs, setConnectorArgs] = useState(
    JSON.stringify(currentPreset.sampleArgs),
  );
  const [connectorRunning, setConnectorRunning] = useState(false);
  const [connectorResult, setConnectorResult] = useState<{
    ok: boolean;
    toolName: string;
    summary: string;
    durationMs: number;
    output: JsonObject;
    error?: string;
  } | null>(null);

  // URL Context + Semantic Memory state
  const [targetUrl, setTargetUrl] = useState(viewedPack.urlPresets[0]?.url ?? "");
  const [urlPrompt, setUrlPrompt] = useState(viewedPack.urlPresets[0]?.prompt ?? "");
  const [urlRunning, setUrlRunning] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryScopeAll, setMemoryScopeAll] = useState(false);
  const [searchingMemory, setSearchingMemory] = useState(false);
  const [searchResults, setSearchResults] = useState<{
    mode: "semantic" | "lexical";
    query: string;
    results: RankedMemoryResult[];
  } | null>(null);

  // Audio briefing state
  const [voiceName, setVoiceName] = useState<string>("Aria");
  const [briefingFocus, setBriefingFocus] = useState("");
  const [briefingRunning, setBriefingRunning] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [playingBriefingId, setPlayingBriefingId] = useState<string | null>(null);
  const [briefingAnalyser, setBriefingAnalyser] = useState<AnalyserNode | null>(null);

  useEffect(() => {
    setInspectedDomain(activeDomain);
  }, [activeDomain]);

  useEffect(() => {
    const pack = getDomainPack(inspectedDomain);
    const preset = pack.connectors[0];
    setSelectedPresetIdx(0);
    if (preset) {
      setConnectorTool(preset.toolName);
      setConnectorArgs(JSON.stringify(preset.sampleArgs));
    }
    if (pack.urlPresets[0]) {
      setTargetUrl(pack.urlPresets[0].url);
      setUrlPrompt(pack.urlPresets[0].prompt);
    }
  }, [inspectedDomain]);

  async function handleActivateDomain(domainId: DomainId) {
    const res = await activateDomainPack(domainId, customFocus.trim() || undefined);
    if (res.ok) {
      const pack = getDomainPack(domainId);
      toast.success(`Activated ${pack.name} · DAG, mesh & live connectors updated.`);
      setCustomFocus("");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  async function handleRunConnector(e: FormEvent) {
    e.preventDefault();
    if (connectorRunning) return;
    setConnectorRunning(true);
    try {
      const res = await runDomainConnectorServer({
        data: {
          domainId: inspectedDomain,
          toolName: connectorTool,
          argsJson: connectorArgs,
          label: `${viewedPack.shortLabel} · ${currentPreset.label}`,
          saveToMemory: true,
        },
      });
      applySnapshot(res.snapshot);
      setConnectorResult({
        ok: res.ok,
        toolName: res.toolName,
        summary: res.summary,
        durationMs: res.durationMs,
        output: res.output,
        error: res.error,
      });
      if (res.ok) {
        toast.success(`${res.toolName} completed (${res.durationMs}ms) & archived to memory.`);
      } else if (res.error) {
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setConnectorRunning(false);
    }
  }

  async function handleAnalyzeUrl(e: FormEvent) {
    e.preventDefault();
    if (urlRunning || !targetUrl.trim()) return;
    setUrlRunning(true);
    setUrlError(null);
    try {
      const res = await analyzeUrlContextServer({
        data: {
          domainId: activeDomain,
          urls: [targetUrl.trim()],
          prompt: urlPrompt.trim() || "Extract concrete operational findings and facts.",
        },
      });
      applySnapshot(res.snapshot);
      if (res.ok) {
        toast.success("URL analyzed via NVIDIA Nemotron Super 49B and archived.");
      } else if (res.error) {
        setUrlError(res.error);
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUrlError(msg);
      toast.error(msg);
    } finally {
      setUrlRunning(false);
    }
  }

  async function handleSearchMemory(e: FormEvent) {
    e.preventDefault();
    if (searchingMemory) return;
    const trimmed = memoryQuery.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }
    setSearchingMemory(true);
    try {
      const res = await searchDomainMemoriesServer({
        data: {
          domainId: memoryScopeAll ? "all" : activeDomain,
          query: trimmed,
        },
      });
      setSearchResults({
        mode: res.mode,
        query: trimmed,
        results: res.results,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchingMemory(false);
    }
  }

  async function handleGenerateBriefing(e: FormEvent) {
    e.preventDefault();
    if (briefingRunning) return;
    setBriefingRunning(true);
    setBriefingError(null);
    try {
      const res = await generateAudioBriefingServer({
        data: {
          domainId: activeDomain,
          voiceName,
          customFocus: briefingFocus.trim() || undefined,
        },
      });
      applySnapshot(res.snapshot);
      if (res.ok) {
        toast.success(`Synthesized WAV executive briefing (${voiceName}).`);
        setBriefingFocus("");
      } else if (res.error) {
        setBriefingError(res.error);
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBriefingError(msg);
      toast.error(msg);
    } finally {
      setBriefingRunning(false);
    }
  }

  const visibleMemories = domainMemories.filter(
    (m) => memoryScopeAll || m.domainId === activeDomain,
  );
  const activeBriefings = audioBriefings.filter((b) => b.domainId === activeDomain);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term/60">
      {/* Sub-navigation Strip */}
      <div className="flex flex-none items-center justify-between gap-2 border-b border-border bg-secondary/25 px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubView("packs")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
              subView === "packs"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Layers className="size-3.5" />
            <span>Domain Packs &amp; Connectors</span>
          </button>
          <button
            type="button"
            onClick={() => setSubView("memory")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
              subView === "memory"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Database className="size-3.5" />
            <span className="tabular-nums">URL Context &amp; Memory ({domainMemories.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubView("briefing")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
              subView === "briefing"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <AudioLines className="size-3.5" />
            <span className="tabular-nums">Audio Briefings ({audioBriefings.length})</span>
          </button>
        </div>

        <span className="hidden xl:inline font-mono text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
          Active: <strong className="font-medium text-ok">{getDomainPack(activeDomain).shortLabel}</strong>
        </span>
      </div>

      {/* Subview Body */}
      {subView === "packs" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Left Column: 5 Operational Domain Packs */}
            <div className="space-y-2 lg:col-span-5">
              <Input
                value={customFocus}
                onChange={(e) => setCustomFocus(e.target.value)}
                placeholder="Optional focus (e.g. Phase III oncology, wind grid)…"
                aria-label="Optional custom domain focus"
                className="h-8 bg-term font-mono text-xs"
              />

              <div className="space-y-1.5">
                {packs.map((pack) => {
                  const isActive = pack.id === activeDomain;
                  const isInspected = pack.id === inspectedDomain;
                  return (
                    <div
                      key={pack.id}
                      onClick={() => setInspectedDomain(pack.id)}
                      className={cn(
                        "cursor-pointer rounded border px-2.5 py-2 text-xs transition-colors",
                        isActive
                          ? "border-ok/60 bg-card"
                          : isInspected
                            ? "border-primary/60 bg-card"
                            : "border-border bg-card/70 hover:border-border/90 hover:bg-card",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                            {pack.sectorTag}
                          </p>
                          <p className="font-semibold text-foreground leading-snug">{pack.name}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={isActive ? "outline" : "default"}
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleActivateDomain(pack.id);
                          }}
                          className={cn(
                            "h-6 px-2 font-mono text-[10px] whitespace-nowrap shrink-0",
                            isActive && "border-ok/60 text-ok hover:text-ok",
                          )}
                        >
                          {isActive ? (
                            <>
                              <Check className="size-3" />
                              <span>Active</span>
                            </>
                          ) : (
                            <span>Activate</span>
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Inspected Pack Brief & Live Public API Connector */}
            <div className="space-y-2.5 lg:col-span-7">
              <div className="rounded border border-border bg-card p-3 text-xs space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-foreground">{viewedPack.name}</p>
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    {viewedPack.specialists.length} agents · {viewedPack.connectors.length} live APIs
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {viewedPack.summary}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Roster: {viewedPack.specialists.map((s) => s.name).join(" · ")}
                </p>
              </div>

              <div className="rounded border border-border bg-card p-3 text-xs space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Live Public API Connector · {viewedPack.shortLabel}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Execute zero-auth HTTPS API telemetry and archive verified findings into Domain Memory.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {viewedPack.connectors.map((conn, idx) => (
                      <button
                        key={conn.id}
                        type="button"
                        onClick={() => {
                          setSelectedPresetIdx(idx);
                          setConnectorTool(conn.toolName);
                          setConnectorArgs(JSON.stringify(conn.sampleArgs));
                        }}
                        className={cn(
                          "h-7 rounded border px-2 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                          selectedPresetIdx === idx
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-term text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {conn.label}
                      </button>
                    ))}
                  </div>
                </div>

                <form onSubmit={handleRunConnector} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-warn whitespace-nowrap">
                    {connectorTool}
                  </span>
                  <Input
                    value={connectorArgs}
                    onChange={(e) => setConnectorArgs(e.target.value)}
                    aria-label="Connector JSON arguments"
                    className="h-8 flex-1 min-w-[180px] bg-term font-mono text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={connectorRunning}
                    className="h-8 whitespace-nowrap shrink-0 px-3"
                  >
                    {connectorRunning ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        <span>Querying API…</span>
                      </>
                    ) : (
                      <>
                        <Play className="size-3.5" />
                        <span>Run Connector</span>
                      </>
                    )}
                  </Button>
                </form>

                <p className="font-mono text-[10px] text-muted-foreground">
                  Endpoint: {currentPreset.endpointLabel} — {currentPreset.description}
                </p>

                {connectorResult ? (
                  <div
                    data-testid="domain-connector-output"
                    className="rounded border border-border bg-term p-2.5 font-mono text-[11px] space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={connectorResult.ok ? "text-ok font-medium" : "text-destructive font-medium"}>
                        {connectorResult.toolName} · {connectorResult.ok ? "LIVE OK" : "ERROR"} ·{" "}
                        <span className="tabular-nums">{connectorResult.durationMs}ms</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        Saved to Semantic Memory
                      </span>
                    </div>
                    <p className="text-foreground/95 leading-snug">{connectorResult.summary}</p>
                    <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-card/70 p-2 text-[10px] text-muted-foreground whitespace-pre-wrap">
                      {JSON.stringify(connectorResult.output, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : subView === "memory" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
          {/* NVIDIA URL Context Analyzer */}
          <form
            onSubmit={handleAnalyzeUrl}
            className="rounded border border-border bg-card p-3 text-xs space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium text-foreground">
                <Globe className="size-3.5 text-warn" />
                <span>URL Context Document Ingestion · nvidia/llama-3.3-nemotron-super-49b-v1</span>
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {viewedPack.urlPresets.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    onClick={() => {
                      setTargetUrl(p.url);
                      setUrlPrompt(p.prompt);
                    }}
                    className="rounded border border-border bg-term px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://..."
                aria-label="Target public HTTPS URL"
                className="h-8 bg-term font-mono text-xs"
                required
              />
              <div className="flex items-center gap-2">
                <Input
                  value={urlPrompt}
                  onChange={(e) => setUrlPrompt(e.target.value)}
                  placeholder="Extraction & synthesis prompt…"
                  aria-label="URL context prompt"
                  className="h-8 flex-1 bg-term text-xs"
                  required
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={urlRunning}
                  className="h-8 whitespace-nowrap shrink-0 px-3"
                >
                  {urlRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
                  <span>Analyze URL</span>
                </Button>
              </div>
            </div>

            {urlError ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{urlError}</span>
              </div>
            ) : null}
          </form>

          {/* Semantic Knowledge Base Search */}
          <div className="rounded border border-border bg-card p-3 text-xs space-y-2.5">
            <form onSubmit={handleSearchMemory} className="flex flex-wrap items-center gap-2">
              <Input
                value={memoryQuery}
                onChange={(e) => {
                  setMemoryQuery(e.target.value);
                  if (!e.target.value.trim()) setSearchResults(null);
                }}
                placeholder="Semantic memory search (nvidia/nv-embedqa-e5-v5 cosine similarity + lexical fallback)…"
                aria-label="Search domain memory"
                className="h-8 flex-1 min-w-[200px] bg-term font-mono text-xs"
              />
              <label className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={memoryScopeAll}
                  onChange={(e) => setMemoryScopeAll(e.target.checked)}
                />
                <span>All Domains</span>
              </label>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={searchingMemory}
                className="h-8 whitespace-nowrap shrink-0 px-3"
              >
                {searchingMemory ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                <span>Search</span>
              </Button>
            </form>

            {searchResults ? (
              <div className="space-y-2">
                <p className="font-mono text-[10px] text-muted-foreground">
                  Matched {searchResults.results.length} entries via{" "}
                  <strong className="text-foreground">{searchResults.mode}</strong> ranking for &ldquo;
                  {searchResults.query}&rdquo;
                </p>
                {searchResults.results.length === 0 ? (
                  <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">
                    No matching domain memories found.
                  </p>
                ) : (
                  <div className="divide-y divide-border/60 rounded border border-border bg-term">
                    {searchResults.results.map(({ item, score, matchKind }) => (
                      <div key={item.id} className="p-2.5 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                          <span className="font-medium text-foreground">{item.title}</span>
                          <span className="text-ok tabular-nums">
                            {matchKind} {Math.round(score * 100)}% · {item.domainId} ·{" "}
                            {formatAgo(item.createdAt, now)}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">{item.summary}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : visibleMemories.length === 0 ? (
              <p className="py-6 text-center font-mono text-[11px] text-muted-foreground">
                No archived findings for this domain yet. Run a live connector or URL analysis to populate Domain Memory.
              </p>
            ) : (
              <div className="divide-y divide-border/60 rounded border border-border bg-term">
                {visibleMemories.map((m) => (
                  <div key={m.id} className="p-2.5 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                      <span className="font-medium text-foreground">{m.title}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {m.sourceType} · {m.hasEmbedding ? `vec:${m.embeddingDimensions}d` : "lexical"} ·{" "}
                        {formatAgo(m.createdAt, now)}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">{m.summary}</p>
                    {m.sourceUrl ? (
                      <a
                        href={m.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-ok hover:underline"
                      >
                        <span>{m.sourceUrl}</span>
                        <ExternalLink className="size-2.5" />
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Executive Audio Briefing Subview */
        <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
          <form
            onSubmit={handleGenerateBriefing}
            className="rounded border border-border bg-card p-3 text-xs space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 font-mono text-[11px] font-medium text-foreground">
                <D3SpeechWaveform
                  variant="badge"
                  speaking={playingBriefingId !== null}
                  active={playingBriefingId !== null}
                  tone="ok"
                  analyser={briefingAnalyser}
                  data-testid="briefing-badge-waveform"
                />
                <span>Executive Audio Briefing · nvidia/magpie-tts-multilingual (WAV)</span>
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                Domain: {getDomainPack(activeDomain).name}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Select TTS briefing voice"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                className="h-8 rounded border border-border bg-term px-2 font-mono text-xs text-foreground"
              >
                {LIVE_VOICE_PRESETS.map((v) => (
                  <option key={v} value={v}>
                    Voice: {v}
                  </option>
                ))}
              </select>
              <Input
                value={briefingFocus}
                onChange={(e) => setBriefingFocus(e.target.value)}
                placeholder="Optional briefing angle (e.g. summarize top safety signals & open tasks)…"
                aria-label="Executive audio briefing focus"
                className="h-8 flex-1 min-w-[200px] bg-term text-xs"
              />
              <Button
                type="submit"
                size="sm"
                disabled={briefingRunning}
                className="h-8 whitespace-nowrap shrink-0 px-3"
              >
                {briefingRunning ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>Synthesizing WAV…</span>
                  </>
                ) : (
                  <>
                    <AudioLines className="size-3.5" />
                    <span>Generate Audio Brief</span>
                  </>
                )}
              </Button>
            </div>

            {briefingError ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{briefingError}</span>
              </div>
            ) : null}
          </form>

          {activeBriefings.length === 0 && audioBriefings.length === 0 ? (
            <div className="flex min-h-[140px] flex-col items-center justify-center gap-1 rounded border border-dashed border-border bg-card/40 p-4 text-center">
              <p className="text-xs font-medium text-foreground">
                No Executive Audio Briefings Synthesized Yet
              </p>
              <p className="max-w-md text-[11px] text-muted-foreground">
                Synthesize a crisp spoken WAV briefing grounded in the active domain&apos;s mission,
                open DAG tasks, and live connector memories.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {(activeBriefings.length > 0 ? activeBriefings : audioBriefings).map((b) => (
                <div key={b.id} className="rounded border border-border bg-card p-3 text-xs space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold text-foreground">{b.title}</span>
                    <div className="flex items-center gap-2 text-muted-foreground tabular-nums">
                      <span>
                        {b.voiceName} · {b.domainId} · {formatAgo(b.createdAt, now)}
                      </span>
                      <a
                        href={b.audioDataUrl}
                        download={`cletus-${b.id}.wav`}
                        className="inline-flex items-center gap-1 rounded border border-border bg-term px-2 py-0.5 text-[10px] text-foreground hover:border-primary/50"
                      >
                        <Download className="size-3" />
                        <span>WAV</span>
                      </a>
                    </div>
                  </div>
                  <audio
                    controls
                    src={b.audioDataUrl}
                    onPlay={(e) => {
                      setPlayingBriefingId(b.id);
                      const an = ensureMediaElementAnalyser(e.currentTarget);
                      if (an) setBriefingAnalyser(an);
                    }}
                    onPause={() => {
                      setPlayingBriefingId((cur) => (cur === b.id ? null : cur));
                    }}
                    onEnded={() => {
                      setPlayingBriefingId((cur) => (cur === b.id ? null : cur));
                    }}
                    className="w-full h-9"
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{b.script}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
