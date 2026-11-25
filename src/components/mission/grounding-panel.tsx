import { useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CornerDownLeft,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Navigation,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBrowserLatLng } from "@/lib/cletus/browser-audio";
import { runGroundingQueryServer } from "@/lib/cletus/server";
import { useCletusStore } from "@/lib/cletus/store";
import type { GeoGroundingPlace, WebGroundingSource } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";

const SEARCH_EXAMPLES = [
  "Latest Model Context Protocol & multi-agent benchmarks 2026",
  "Current Node.js 22 native TypeScript test runner features",
];

const MAPS_EXAMPLES = [
  "Top robotics and AI hardware coworking labs in San Francisco",
  "Quiet specialty coffee shops with fast Wi-Fi near downtown Seattle",
];

export function GroundingPanel() {
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const issueDecree = useCletusStore((s) => s.issueDecree);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [mode, setMode] = useState<"search" | "maps">("search");
  const [query, setQuery] = useState("");
  const [useLocation, setUseLocation] = useState(true);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{
    mode: "search" | "maps";
    query: string;
    summary: string;
    webSources: WebGroundingSource[];
    mapsPlaces: GeoGroundingPlace[];
  } | null>(null);

  async function executeQuery(rawQuery: string, targetMode: "search" | "maps") {
    const trimmed = rawQuery.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setErrorMsg(null);

    try {
      let latLng: { latitude: number; longitude: number } | undefined;
      if (targetMode === "maps" && useLocation) {
        latLng = coords ?? (await getBrowserLatLng());
        if (latLng) setCoords(latLng);
      }

      const res = await runGroundingQueryServer({
        data: {
          mode: targetMode,
          query: trimmed,
          latLng,
        },
      });
      applySnapshot(res.snapshot);
      if (res.ok) {
        setResult({
          mode: res.mode,
          query: res.query,
          summary: res.summary,
          webSources: res.webSources,
          mapsPlaces: res.mapsPlaces,
        });
      } else if (res.error) {
        setErrorMsg(res.error);
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void executeQuery(query, mode);
  }

  async function handleDispatchFinding() {
    if (!result || turnRunning) return;
    const sourcesNote =
      result.webSources.length > 0
        ? ` Sources: ${result.webSources
            .slice(0, 3)
            .map((s) => s.uri)
            .join(", ")}`
        : "";
    const directive = `Incorporate ${result.mode === "search" ? "Web Search" : "OpenStreetMap Geo"} grounded findings for "${result.query}": ${result.summary.slice(0, 1200)}${sourcesNote}`;
    const res = await issueDecree(directive.slice(0, 1950));
    if (res.ok) {
      toast.success("Grounded intelligence dispatched to Orchestrator-Prime.");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  const examples = mode === "search" ? SEARCH_EXAMPLES : MAPS_EXAMPLES;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term/60">
      {/* Query Controls */}
      <form
        onSubmit={handleSubmit}
        className="flex-none space-y-2 border-b border-border bg-secondary/25 p-3 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded border border-border bg-term p-0.5">
            <button
              type="button"
              onClick={() => setMode("search")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                mode === "search"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Globe className="size-3.5" />
              <span>Web Search</span>
            </button>
            <button
              type="button"
              onClick={() => setMode("maps")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                mode === "maps"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MapPin className="size-3.5" />
              <span>Geo / Places</span>
            </button>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            {mode === "maps" ? (
              <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={useLocation}
                  onChange={(e) => setUseLocation(e.target.checked)}
                />
                <Navigation className="size-3 text-warn" />
                <span>
                  {coords
                    ? `Geo ${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}`
                    : "Use Browser Geo"}
                </span>
              </label>
            ) : (
              <span>Model: nvidia/llama-3.3-nemotron-super-49b-v1 · Web Grounding</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              mode === "search"
                ? "Query live web intelligence synthesized via NVIDIA NIM…"
                : "Query real-world places, venues, or coordinates via OpenStreetMap…"
            }
            aria-label="Web or Geospatial grounding query"
            disabled={running}
            className="h-8 flex-1 bg-term font-mono text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={running || query.trim().length < 2}
            className="h-8 whitespace-nowrap shrink-0 px-3"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
            <span>{mode === "search" ? "Search Web" : "Query Geo"}</span>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span>Presets:</span>
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setQuery(ex)}
              className="rounded border border-border bg-term px-2 py-0.5 text-left text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              {ex.length > 48 ? `${ex.slice(0, 47)}…` : ex}
            </button>
          ))}
        </div>
      </form>

      {/* Output Area */}
      <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {errorMsg ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words">{errorMsg}</p>
          </div>
        ) : null}

        {running ? (
          <div className="flex items-center gap-2 rounded border border-border bg-card p-3 font-mono text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-ok" />
            <span>
              Running {mode === "search" ? "Web Search" : "OpenStreetMap Geo"} grounding on NVIDIA
              Nemotron Super 49B…
            </span>
          </div>
        ) : result ? (
          <div className="space-y-3">
            <div className="rounded border border-border bg-card p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                <span className="text-ok font-medium uppercase">
                  {result.mode === "search" ? "Web Search Grounded" : "OpenStreetMap Geo Grounded"}
                </span>
                <div className="flex items-center gap-2">
                  <span>nvidia/llama-3.3-nemotron-super-49b-v1</span>
                  <button
                    type="button"
                    disabled={turnRunning}
                    onClick={() => void handleDispatchFinding()}
                    className="inline-flex items-center gap-1 rounded border border-border bg-term px-2 py-0.5 text-[10px] text-foreground hover:border-primary/40 disabled:opacity-40"
                  >
                    <CornerDownLeft className="size-2.5" />
                    <span>Dispatch to Cletus</span>
                  </button>
                </div>
              </div>
              <p className="whitespace-pre-wrap leading-relaxed text-foreground">{result.summary}</p>
            </div>

            {result.webSources.length > 0 ? (
              <div className="rounded border border-border bg-card p-3 text-xs space-y-2">
                <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Verified Web Sources ({result.webSources.length})
                </p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {result.webSources.map((src) => (
                    <a
                      key={src.uri}
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 rounded border border-border/70 bg-term px-2.5 py-2 font-mono text-[11px] text-ok hover:border-ok/50"
                    >
                      <span className="truncate">{src.title}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            {result.mapsPlaces.length > 0 ? (
              <div className="rounded border border-border bg-card p-3 text-xs space-y-2">
                <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  OpenStreetMap Geospatial Places ({result.mapsPlaces.length})
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {result.mapsPlaces.map((place) => (
                    <div
                      key={`${place.title}-${place.uri}`}
                      className="rounded border border-border/70 bg-term p-2.5 space-y-1.5"
                    >
                      {place.uri ? (
                        <a
                          href={place.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-warn hover:underline"
                        >
                          <MapPin className="size-3.5 shrink-0" />
                          <span>{place.title}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ) : (
                        <p className="font-mono text-xs font-medium text-foreground">{place.title}</p>
                      )}

                      {place.reviewSnippets.length > 0 ? (
                        <div className="space-y-1 border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground">
                          {place.reviewSnippets.map((snip, idx) => (
                            <p key={idx} className="leading-snug italic">
                              &ldquo;{snip}&rdquo;
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-1 text-center">
            <p className="text-xs font-medium text-foreground">
              Real-Time Web &amp; OpenStreetMap Geo Grounding
            </p>
            <p className="max-w-md text-[11px] text-muted-foreground">
              Switch between live Web Search (<code className="font-mono text-foreground">webSearch</code>)
              and OpenStreetMap Geocoding (<code className="font-mono text-foreground">osmNominatim</code>)
              synthesized via{" "}
              <span className="font-mono text-foreground">nvidia/llama-3.3-nemotron-super-49b-v1</span>{" "}
              for live citations and geospatial links.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
