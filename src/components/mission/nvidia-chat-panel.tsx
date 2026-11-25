import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CornerDownLeft,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Mic,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getBrowserLatLng,
  pickRecorderMimeType,
  prepareAudioBlobForAsr,
} from "@/lib/cletus/browser-audio";
import { formatAgo } from "@/lib/cletus/format";
import {
  CHAT_MODELS,
  CHAT_SYSTEM_ROLES,
  NVIDIA_PRIMARY_MODEL,
  resolveChatRequestModel,
  resolveSystemRoleInstruction,
} from "@/lib/cletus/nvidia-inference";
import {
  clearNvidiaChatServer,
  getNvidiaChatHistoryServer,
  sendNvidiaChatServer,
  transcribeAudioServer,
} from "@/lib/cletus/server";
import { useCletusStore } from "@/lib/cletus/store";
import type {
  InferenceGroundingMode,
  NvidiaChatMessage,
  NvidiaChatModelId,
} from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { MicLevelIndicator, useMicAudioLevel } from "./mic-level-indicator";
import { useMissionClock } from "./snapshot-context";

export function NvidiaChatPanel() {
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const issueDecree = useCletusStore((s) => s.issueDecree);
  const turnRunning = useCletusStore((s) => s.turnRunning);
  const now = useMissionClock();

  const [messages, setMessages] = useState<NvidiaChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [model, setModel] = useState<NvidiaChatModelId>(NVIDIA_PRIMARY_MODEL);
  const [systemRole, setSystemRole] = useState<string>(CHAT_SYSTEM_ROLES[0]!.id);
  const [showSystemEditor, setShowSystemEditor] = useState(false);
  const [customSystemInstruction, setCustomSystemInstruction] = useState("");
  const [groundingMode, setGroundingMode] = useState<InferenceGroundingMode>("none");
  const [includeMissionContext, setIncludeMissionContext] = useState(true);
  const [draft, setDraft] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Inline mic-to-transcribe state (nvidia/parakeet-ctc-1.1b-asr)
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micLevel = useMicAudioLevel(micStream, recording);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await getNvidiaChatHistoryServer({ data: { threadId: "default" } });
        if (active) setMessages(res.messages);
      } catch (err) {
        if (active) setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoadingHistory(false);
      }
    })();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const effectiveModel = resolveChatRequestModel(model, groundingMode);
  const activeModelMeta = CHAT_MODELS.find((m) => m.id === effectiveModel) ?? CHAT_MODELS[0]!;
  const effectiveInstruction = resolveSystemRoleInstruction(systemRole, customSystemInstruction);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setDraft("");
    setErrorMsg(null);
    setSending(true);

    try {
      const latLng = groundingMode === "maps" ? await getBrowserLatLng() : undefined;
      const res = await sendNvidiaChatServer({
        data: {
          threadId: "default",
          message: trimmed,
          model,
          systemRole,
          customSystemInstruction: customSystemInstruction.trim() || undefined,
          groundingMode,
          includeMissionContext,
          latLng,
        },
      });
      setMessages(res.messages);
      applySnapshot(res.snapshot);
      if (!res.ok) {
        setDraft((cur) => cur || trimmed);
        if (res.error) {
          setErrorMsg(res.error);
          toast.error(res.error);
        }
      }
    } catch (err) {
      setDraft((cur) => cur || trimmed);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  async function handleDispatchReply(content: string) {
    const snippet = content.trim().slice(0, 1800);
    if (!snippet || turnRunning) return;
    const res = await issueDecree(`Apply this NVIDIA NIM analysis: ${snippet}`);
    if (res.ok) {
      toast.success("Dispatched NVIDIA NIM reply to Orchestrator-Prime.");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  async function handleClear() {
    if (clearing || sending) return;
    setClearing(true);
    setErrorMsg(null);
    try {
      const res = await clearNvidiaChatServer({ data: { threadId: "default" } });
      setMessages(res.messages);
      applySnapshot(res.snapshot);
      toast.success("Cleared NVIDIA NIM chat thread.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setClearing(false);
    }
  }

  async function toggleMicDictation() {
    if (transcribing) return;
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Microphone capture is not available in this browser context.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicStream(stream);
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setMicStream(null);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (blob.size < 100) return;

        void (async () => {
          setTranscribing(true);
          try {
            const prepared = await prepareAudioBlobForAsr(blob, mimeType);
            const res = await transcribeAudioServer({
              data: prepared,
            });
            applySnapshot(res.snapshot);
            if (res.ok && res.text) {
              setDraft((prev) => (prev.trim() ? `${prev.trim()} ${res.text}` : res.text));
              toast.success("Transcribed speech with nvidia/parakeet-ctc-1.1b-asr.");
            } else if (res.error) {
              setErrorMsg(res.error);
              toast.error(res.error);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            toast.error(msg);
          } finally {
            setTranscribing(false);
          }
        })();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone permission denied.";
      toast.error(msg);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Configuration Header */}
      <div className="flex-none space-y-2 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">
              NVIDIA NIM Multi-Turn Console
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {activeModelMeta.id} · {activeModelMeta.tier}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowSystemEditor((v) => !v)}
              aria-label="Toggle system instruction editor"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded border px-2 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                showSystemEditor
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-term text-muted-foreground hover:text-foreground",
              )}
            >
              <SlidersHorizontal className="size-3" />
              <span>Role Prompt</span>
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={clearing || sending || messages.length === 0}
              aria-label="Clear chat thread"
              className="inline-flex h-7 items-center gap-1 rounded border border-border bg-term px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Trash2 className="size-3" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* Model + Role + Grounding Controls */}
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1.2fr_1fr]">
          <select
            aria-label="Select NVIDIA NIM chat model"
            value={model}
            onChange={(e) => setModel(e.target.value as NvidiaChatModelId)}
            className="h-7 min-w-0 w-full rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
          >
            {CHAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.tier}
              </option>
            ))}
          </select>

          <select
            aria-label="Select system instruction role"
            value={systemRole}
            onChange={(e) => setSystemRole(e.target.value)}
            className="h-7 min-w-0 w-full rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
          >
            {CHAT_SYSTEM_ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded border border-border bg-term p-0.5">
            {(
              [
                { id: "none", label: "Standard" },
                { id: "search", label: "Web Search", icon: Globe },
                { id: "maps", label: "OSM Geo", icon: MapPin },
              ] as Array<{ id: InferenceGroundingMode; label: string; icon?: typeof Globe }>
            ).map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setGroundingMode(opt.id)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded px-2 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                    groundingMode === opt.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {Icon ? <Icon className="size-3" /> : null}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2.5 font-mono text-[10px] text-muted-foreground tabular-nums">
            <label className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap">
              <input
                type="checkbox"
                checked={includeMissionContext}
                onChange={(e) => setIncludeMissionContext(e.target.checked)}
              />
              <span>Mission Context</span>
            </label>
            <span>
              {messages.length} turns
              {groundingMode !== "none" ? ` · ${groundingMode}` : ""}
            </span>
          </div>
        </div>

        {showSystemEditor ? (
          <div className="space-y-1 rounded border border-border bg-term p-2">
            <label
              htmlFor="nvidia-chat-sys-prompt"
              className="block font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              System Instruction ({customSystemInstruction.trim() ? "Custom" : "Preset Active"})
            </label>
            <textarea
              id="nvidia-chat-sys-prompt"
              rows={2}
              value={customSystemInstruction}
              onChange={(e) => setCustomSystemInstruction(e.target.value)}
              placeholder={effectiveInstruction}
              className="w-full resize-none rounded border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ) : null}
      </div>

      {/* Scrollable Multi-Turn Thread */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2.5 overflow-auto bg-term/60 p-3"
      >
        {loadingHistory ? (
          <div className="flex h-full min-h-[140px] items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Loading conversation history…</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-1.5 text-center px-3">
            <p className="text-xs font-medium text-foreground">
              Persistent Multi-Turn NVIDIA NIM Thread Ready
            </p>
            <p className="max-w-sm text-[11px] text-muted-foreground">
              Select <span className="font-mono text-foreground">Nemotron Super 49B</span> for
              reasoning &amp; grounding,{" "}
              <span className="font-mono text-foreground">Llama 3.3 70B</span> for engineering,{" "}
              <span className="font-mono text-foreground">DeepSeek-R1 NIM</span> for formal audit,
              or <span className="font-mono text-foreground">Nemotron Nano 8B</span> for fast ops.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const isUser = m.role === "user";
            return (
              <div
                key={m.id}
                className={cn(
                  "flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs",
                  isUser ? "ml-6 border-primary/30 bg-secondary/60" : "mr-4 border-border bg-card",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                  <span className={isUser ? "font-medium text-warn" : "font-medium text-ok"}>
                    {isUser ? "Operator" : m.model}
                    {m.groundingMode !== "none" ? ` · ${m.groundingMode}` : ""}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatAgo(m.createdAt, now)}
                  </span>
                </div>

                <p className="whitespace-pre-wrap leading-relaxed text-foreground">{m.content}</p>

                {m.webSources.length > 0 ? (
                  <div className="space-y-1 border-t border-border/60 pt-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      Web Citations
                    </p>
                    <ul className="space-y-1">
                      {m.webSources.map((src) => (
                        <li key={src.uri}>
                          <a
                            href={src.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-ok hover:underline break-all"
                          >
                            <ExternalLink className="size-3 shrink-0" />
                            <span>{src.title}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {m.mapsPlaces.length > 0 ? (
                  <div className="space-y-1.5 border-t border-border/60 pt-1.5">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      OpenStreetMap Geospatial Places
                    </p>
                    <ul className="space-y-1.5">
                      {m.mapsPlaces.map((place) => (
                        <li
                          key={`${place.title}-${place.uri}`}
                          className="rounded border border-border/60 bg-term px-2 py-1.5"
                        >
                          {place.uri ? (
                            <a
                              href={place.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-warn hover:underline"
                            >
                              <MapPin className="size-3 shrink-0" />
                              <span>{place.title}</span>
                              <ExternalLink className="size-2.5 shrink-0" />
                            </a>
                          ) : (
                            <span className="font-mono text-[11px] font-medium text-foreground">
                              {place.title}
                            </span>
                          )}
                          {place.reviewSnippets.length > 0 ? (
                            <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                              {place.reviewSnippets.map((snip, idx) => (
                                <p key={idx} className="italic">
                                  &ldquo;{snip}&rdquo;
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {!isUser ? (
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      disabled={turnRunning}
                      onClick={() => void handleDispatchReply(m.content)}
                      className="inline-flex items-center gap-1 rounded border border-border bg-term px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      <CornerDownLeft className="size-2.5" />
                      <span>Dispatch Directive</span>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}

        {sending ? (
          <div className="mr-4 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-ok" />
            <span>Synthesizing turn via {effectiveModel}…</span>
          </div>
        ) : null}
      </div>

      {errorMsg ? (
        <div
          role="alert"
          className="flex flex-none items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 break-words">{errorMsg}</p>
        </div>
      ) : null}

      {/* Composer */}
      <form
        onSubmit={handleSend}
        className="flex flex-none items-center gap-1.5 border-t border-border bg-card p-2.5"
      >
        <Button
          type="button"
          variant={recording ? "destructive" : "outline"}
          size="icon-sm"
          disabled={sending || transcribing}
          onClick={() => void toggleMicDictation()}
          aria-label={
            recording
              ? "Stop voice dictation"
              : "Dictate message with nvidia/parakeet-ctc-1.1b-asr"
          }
          className={cn("size-8 shrink-0", recording && "mic-listening-ring")}
        >
          {transcribing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : recording ? (
            <Square className="size-3" />
          ) : (
            <Mic className="size-3.5" />
          )}
        </Button>

        {recording ? <MicLevelIndicator active level={micLevel} compact /> : null}

        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Ask ${activeModelMeta.label}${groundingMode !== "none" ? ` (${groundingMode})` : ""}…`}
          aria-label="NVIDIA chat message input"
          disabled={sending}
          className="h-8 flex-1 bg-term text-xs"
        />

        <Button
          type="submit"
          size="sm"
          disabled={sending || !draft.trim()}
          className="h-8 whitespace-nowrap shrink-0 px-3"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          <span>Send</span>
        </Button>
      </form>
    </div>
  );
}
