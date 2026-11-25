import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  Copy,
  FileAudio,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickRecorderMimeType, prepareAudioBlobForAsr } from "@/lib/cletus/browser-audio";
import {
  downsampleFloat32,
  float32ToPcm16Base64,
  LIVE_VOICE_PRESETS,
  pcm16Base64ToFloat32,
  type LiveVoicePreset,
} from "@/lib/cletus/nvidia-inference";
import { speakToCletusDirectServer, transcribeAudioServer } from "@/lib/cletus/server";
import { synthesizeVoiceCheckPcm16Base64 } from "@/lib/cletus/speech-waveform";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { D3SpeechWaveform, type SpeechBoundarySignal } from "./d3-speech-waveform";
import { MicLevelIndicator, useMicAudioTelemetry } from "./mic-level-indicator";
import { useMissionField } from "./snapshot-context";

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  0?: { transcript?: string };
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognitionInstance;

function getBrowserSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface LiveTranscriptLine {
  id: string;
  speaker: "operator" | "cletus" | "system";
  text: string;
}

type LiveState = "idle" | "connecting" | "connected" | "error";

export function VoiceLivePanel() {
  const vitals = useMissionField((s) => s.vitals);
  const missions = useMissionField((s) => s.missions);
  const inbox = useMissionField((s) => s.inbox);
  const nvidiaConfigured = useMissionField((s) => s.nvidiaConfigured);

  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const issueDecree = useCletusStore((s) => s.issueDecree);
  const refresh = useCletusStore((s) => s.refresh);

  const activeMission = useMemo(
    () => missions.find((m) => m.id === vitals.activeMissionId) ?? missions[0] ?? null,
    [missions, vitals.activeMissionId],
  );

  // Hydrate recent persisted [Voice] exchanges from Operator Bridge
  const persistedVoiceLines = useMemo<LiveTranscriptLine[]>(() => {
    return inbox
      .filter((m) => m.content.startsWith("[Voice]"))
      .slice()
      .sort((a, b) => a.at - b.at)
      .slice(-16)
      .map((m) => ({
        id: m.id,
        speaker: m.from === "creator" ? "operator" : "cletus",
        text: m.content.replace(/^\[Voice\]\s*/i, ""),
      }));
  }, [inbox]);

  // Live Voice State (Cletus Direct Conversation: Parakeet ASR + Nemotron Cletus + Magpie TTS)
  const [liveState, setLiveState] = useState<LiveState>("idle");
  const [voiceName, setVoiceName] = useState<LiveVoicePreset>("Aria");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [sendingDirect, setSendingDirect] = useState(false);
  const [browserTtsEnabled, setBrowserTtsEnabled] = useState(true);
  const [ttsNotice, setTtsNotice] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveTextDraft, setLiveTextDraft] = useState("");
  const [transcript, setTranscript] = useState<LiveTranscriptLine[]>([]);
  const [liveMicStream, setLiveMicStream] = useState<MediaStream | null>(null);

  // Refs for WebSocket, Web Audio AnalyserNode, & speech boundaries
  const wsRef = useRef<WebSocket | null>(null);
  const mutedRef = useRef(false);
  const liveConnectedRef = useRef(false);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const boundarySignalRef = useRef<SpeechBoundarySignal>({ atMs: 0, charIndex: 0 });
  const pendingOutputTranscriptRef = useRef<string | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const liveRecognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null);
  const liveRecognitionShouldRunRef = useRef(false);

  // Audio Transcription State (nvidia/parakeet-ctc-1.1b-asr + browser fallback)
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [recMicStream, setRecMicStream] = useState<MediaStream | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [asrNotice, setAsrNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recRecognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null);
  const recBrowserSpeechRef = useRef<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live audio level + AnalyserNode computed for whichever mic stream is active
  const activeMicStream = liveMicStream ?? recMicStream;
  const isMicActive = liveState === "connected" || recState === "recording";
  const isMicMuted = liveState === "connected" ? muted : false;
  const micTelemetry = useMicAudioTelemetry(activeMicStream, isMicActive, isMicMuted);
  const micLevel = micTelemetry.level;

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const displayedTranscript = transcript.length > 0 ? transcript : persistedVoiceLines;

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayedTranscript.length]);

  useEffect(() => {
    if (recState !== "recording") return;
    const id = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [recState]);

  const ensureOutputAudioPipeline = useCallback((): {
    ctx: AudioContext;
    analyser: AnalyserNode;
  } => {
    let ctx = outputAudioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 24000 });
      outputAudioCtxRef.current = ctx;
      nextStartTimeRef.current = ctx.currentTime;
    }
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    let analyser = outputAnalyserRef.current;
    if (!analyser || analyser.context !== ctx) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      analyser.connect(ctx.destination);
      outputAnalyserRef.current = analyser;
    }
    return { ctx, analyser };
  }, []);

  const speakWithBrowserFallback = useCallback(
    (text: string) => {
      if (!browserTtsEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) {
        return;
      }
      const clean = text.trim();
      if (!clean) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(clean);
        utter.rate = 1.02;
        utter.pitch = 0.96;
        utter.onstart = () => {
          boundarySignalRef.current = { atMs: performance.now(), charIndex: 0 };
          setSpeaking(true);
        };
        utter.onboundary = (ev) => {
          boundarySignalRef.current = {
            atMs: performance.now(),
            charIndex: typeof ev.charIndex === "number" ? ev.charIndex : 0,
          };
        };
        utter.onpause = () => setSpeaking(false);
        utter.onresume = () => {
          boundarySignalRef.current = { atMs: performance.now(), charIndex: 0 };
          setSpeaking(true);
        };
        utter.onend = () => setSpeaking(false);
        utter.onerror = () => setSpeaking(false);
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore speech synthesis errors in restricted contexts
      }
    },
    [browserTtsEnabled],
  );

  const stopPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Ignore already stopped source
      }
    }
    activeSourcesRef.current.clear();
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }
    setSpeaking(false);
  }, []);

  const appendTranscript = useCallback(
    (speaker: LiveTranscriptLine["speaker"], text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setTranscript((prev) => {
        const base = prev.length > 0 ? prev : persistedVoiceLines;
        const last = base[base.length - 1];
        if (last && last.speaker === speaker && speaker !== "system") {
          const merged = `${last.text} ${clean}`.trim();
          return [...base.slice(0, -1), { ...last, text: merged }];
        }
        return [
          ...base.slice(-39),
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, speaker, text: clean },
        ];
      });
    },
    [persistedVoiceLines],
  );

  function playPcmChunk(base64Audio: string, mimeType?: string) {
    const { ctx, analyser } = ensureOutputAudioPipeline();

    const float32 = pcm16Base64ToFloat32(base64Audio);
    if (float32.length === 0) return;

    const rateMatch = mimeType?.match(/rate=(\d+)/i);
    const parsedRate = rateMatch ? Number(rateMatch[1]) : 24000;
    const sampleRate =
      Number.isFinite(parsedRate) && parsedRate >= 8000 && parsedRate <= 96000
        ? parsedRate
        : 24000;

    const buffer = ctx.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);

    const nowTime = ctx.currentTime;
    if (nextStartTimeRef.current < nowTime) {
      nextStartTimeRef.current = nowTime + 0.02;
    }
    const scheduledAt = nextStartTimeRef.current;
    nextStartTimeRef.current = scheduledAt + buffer.duration;

    activeSourcesRef.current.add(source);
    setSpeaking(true);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      if (activeSourcesRef.current.size === 0) {
        setSpeaking(false);
      }
    };
    source.start(scheduledAt);
  }

  function handleVoiceOutputCheck() {
    if (speaking) {
      stopPlaybackQueue();
      return;
    }
    const pcmBase64 = synthesizeVoiceCheckPcm16Base64(voiceName, 24000);
    playPcmChunk(pcmBase64, "audio/pcm;rate=24000");
  }

  const startLiveBrowserSpeechFallback = useCallback(() => {
    if (liveRecognitionRef.current) return;
    const Ctor = getBrowserSpeechRecognitionCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "en-US";
      rec.onresult = (ev) => {
        if (!liveConnectedRef.current || mutedRef.current) return;
        const activeWs = wsRef.current;
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
        let finalSegment = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r?.isFinal) {
            finalSegment += ` ${r[0]?.transcript ?? ""}`;
          }
        }
        const cleaned = finalSegment.trim();
        if (cleaned) {
          appendTranscript("operator", cleaned);
          activeWs.send(JSON.stringify({ type: "text", text: cleaned }));
        }
      };
      rec.onerror = () => {
        // Non-fatal; user can still type directly
      };
      rec.onend = () => {
        liveRecognitionRef.current = null;
        if (liveRecognitionShouldRunRef.current && liveConnectedRef.current) {
          window.setTimeout(() => {
            if (liveRecognitionShouldRunRef.current && liveConnectedRef.current) {
              startLiveBrowserSpeechFallback();
            }
          }, 250);
        }
      };
      liveRecognitionRef.current = rec;
      liveRecognitionShouldRunRef.current = true;
      rec.start();
    } catch {
      liveRecognitionRef.current = null;
    }
  }, [appendTranscript]);

  const cleanupLiveResources = useCallback(() => {
    liveConnectedRef.current = false;
    liveRecognitionShouldRunRef.current = false;
    if (liveRecognitionRef.current) {
      try {
        liveRecognitionRef.current.stop();
      } catch {
        // Ignore
      }
      liveRecognitionRef.current = null;
    }
    stopPlaybackQueue();

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // Ignore
      }
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    setLiveMicStream(null);

    if (inputAudioCtxRef.current) {
      void inputAudioCtxRef.current.close().catch(() => undefined);
      inputAudioCtxRef.current = null;
    }

    if (outputAnalyserRef.current) {
      try {
        outputAnalyserRef.current.disconnect();
      } catch {
        // Ignore
      }
      outputAnalyserRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      void outputAudioCtxRef.current.close().catch(() => undefined);
      outputAudioCtxRef.current = null;
    }

    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop" }));
        } catch {
          // Ignore
        }
      }
      ws.close();
    }
  }, [stopPlaybackQueue]);

  useEffect(() => {
    return () => {
      cleanupLiveResources();
      recStreamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        recRecognitionRef.current?.stop();
      } catch {
        // Ignore
      }
    };
  }, [cleanupLiveResources]);

  async function startLiveSession() {
    if (liveState === "connecting" || liveState === "connected") return;
    setLiveError(null);
    setTtsNotice(null);
    setLiveState("connecting");

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      const msg = "Browser microphone capture (navigator.mediaDevices.getUserMedia) is unavailable.";
      setLiveError(msg);
      setLiveState("error");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      setLiveMicStream(stream);

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      ensureOutputAudioPipeline();

      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/live`);
      wsRef.current = ws;

      const source = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(inputCtx.destination);

      processor.onaudioprocess = (event) => {
        if (!liveConnectedRef.current || mutedRef.current || liveRecognitionShouldRunRef.current) return;
        const activeWs = wsRef.current;
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;

        const raw = event.inputBuffer.getChannelData(0);
        const mono16k = downsampleFloat32(raw, inputCtx.sampleRate, 16000);
        const base64 = float32ToPcm16Base64(mono16k);
        activeWs.send(JSON.stringify({ type: "audio", data: base64 }));
      };

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "start",
            voiceName,
          }),
        );
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            status?: string;
            data?: string;
            mimeType?: string;
            text?: string;
            name?: string;
            summary?: string;
            reason?: string;
            error?: string;
          };
          if (msg.type === "status") {
            if (msg.status === "connected") {
              liveConnectedRef.current = true;
              setLiveState("connected");
              appendTranscript(
                "system",
                `Direct voice link active with ${vitals.sigil} (${voiceName}) — synced to Operator Bridge.`,
              );
            } else if (msg.status === "closed") {
              liveConnectedRef.current = false;
              setLiveState((prev) => (prev === "error" ? "error" : "idle"));
            }
          } else if (msg.type === "audio" && msg.data) {
            pendingOutputTranscriptRef.current = null;
            playPcmChunk(msg.data, msg.mimeType);
          } else if (msg.type === "inputTranscript" && msg.text) {
            appendTranscript("operator", msg.text);
          } else if (msg.type === "outputTranscript" && msg.text) {
            appendTranscript("cletus", msg.text);
            pendingOutputTranscriptRef.current = msg.text;
            speakWithBrowserFallback(msg.text);
          } else if (msg.type === "ttsUnavailable") {
            const reason = msg.reason ?? "Server TTS unavailable; using browser speech output.";
            setTtsNotice(reason);
            if (pendingOutputTranscriptRef.current) {
              speakWithBrowserFallback(pendingOutputTranscriptRef.current);
              pendingOutputTranscriptRef.current = null;
            }
          } else if (msg.type === "asrUnavailable") {
            const hasSpeechApi = Boolean(getBrowserSpeechRecognitionCtor());
            setAsrNotice(
              hasSpeechApi
                ? "NVIDIA Parakeet ASR unavailable on API key (403); switched live mic capture to Browser Speech Recognition."
                : msg.reason ?? "NVIDIA Parakeet ASR unavailable on API key; use direct text input below.",
            );
            if (hasSpeechApi) {
              startLiveBrowserSpeechFallback();
              appendTranscript(
                "system",
                "Parakeet ASR 403 — switched live microphone stream to Browser Speech Recognition.",
              );
            }
          } else if (msg.type === "toolCall" && msg.name) {
            appendTranscript("system", `[tool:${msg.name}] ${msg.summary ?? "executed"}`);
          } else if (msg.type === "refreshSnapshot") {
            void refresh({ silent: true });
          } else if (msg.type === "interrupted") {
            stopPlaybackQueue();
          } else if (msg.type === "error" && msg.error) {
            setLiveError(msg.error);
            setLiveState("error");
            toast.error(msg.error);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onerror = () => {
        const msg = "Live Voice WebSocket connection error on /ws/live.";
        setLiveError(msg);
        setLiveState("error");
        cleanupLiveResources();
      };

      ws.onclose = () => {
        liveConnectedRef.current = false;
        setLiveState((prev) => (prev === "error" ? "error" : "idle"));
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start Live Voice session.";
      setLiveError(msg);
      setLiveState("error");
      cleanupLiveResources();
      toast.error(msg);
    }
  }

  function disconnectLiveSession() {
    cleanupLiveResources();
    setLiveState("idle");
    appendTranscript("system", "Live voice session disconnected.");
  }

  async function handleSendDirectToCletus(e: FormEvent) {
    e.preventDefault();
    const trimmed = liveTextDraft.trim();
    if (!trimmed || sendingDirect) return;

    setLiveTextDraft("");
    setLiveError(null);
    appendTranscript("operator", trimmed);

    // If full-duplex WS session is live, push straight over /ws/live
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && liveConnectedRef.current) {
      wsRef.current.send(JSON.stringify({ type: "text", text: trimmed }));
      return;
    }

    // Otherwise execute a direct Cletus spoken/text turn grounded in Cletus persona & DB memory
    setSendingDirect(true);
    try {
      const res = await speakToCletusDirectServer({
        data: {
          text: trimmed,
          voiceName,
          speakTts: true,
        },
      });
      applySnapshot(res.snapshot);

      for (const tool of res.toolsUsed) {
        appendTranscript("system", `[tool:${tool.name}] ${tool.summary}`);
      }

      if (res.ok && res.reply) {
        appendTranscript("cletus", res.reply);
        if (res.audioBase64) {
          playPcmChunk(res.audioBase64, res.audioMimeType);
        } else {
          if (res.ttsUnavailableReason) {
            setTtsNotice(res.ttsUnavailableReason);
          }
          speakWithBrowserFallback(res.reply);
        }
      } else if (res.error) {
        setLiveError(res.error);
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLiveError(msg);
      toast.error(msg);
    } finally {
      setSendingDirect(false);
    }
  }

  async function runTranscriptionBlob(blob: Blob, mimeType: string, browserFallbackText = "") {
    setRecState("transcribing");
    setTranscribeError(null);
    setAsrNotice(null);
    try {
      const prepared = await prepareAudioBlobForAsr(blob, mimeType);
      const res = await transcribeAudioServer({
        data: prepared,
      });
      applySnapshot(res.snapshot);
      if (res.ok) {
        setTranscriptText(res.text);
        toast.success(`Audio transcribed via ${res.modelUsed}.`);
      } else if (res.error) {
        const lower = res.error.toLowerCase();
        const isEntitlement =
          lower.includes("403") || lower.includes("access denied") || lower.includes("404");
        if (isEntitlement && browserFallbackText.trim()) {
          setTranscriptText(browserFallbackText.trim());
          setAsrNotice(
            "NVIDIA Parakeet ASR access denied on API key (403); populated transcript from live Browser Speech Recognition.",
          );
          toast.success("Transcribed via browser Speech Recognition fallback.");
        } else {
          setTranscribeError(res.error);
          toast.error(res.error);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (browserFallbackText.trim()) {
        setTranscriptText(browserFallbackText.trim());
        setAsrNotice("NVIDIA ASR unavailable; populated transcript via Browser Speech Recognition.");
      } else {
        setTranscribeError(msg);
        toast.error(msg);
      }
    } finally {
      setRecState("idle");
    }
  }

  async function toggleStandaloneRecording() {
    if (recState === "transcribing") return;
    if (recState === "recording") {
      try {
        recRecognitionRef.current?.stop();
      } catch {
        // Ignore
      }
      recorderRef.current?.stop();
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setTranscribeError("Browser microphone capture is unavailable.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;
      setRecMicStream(stream);
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      recChunksRef.current = [];
      recBrowserSpeechRef.current = "";
      setRecSeconds(0);
      setTranscribeError(null);
      setAsrNotice(null);

      // Capture parallel browser SpeechRecognition so 403 Parakeet keys never dead-end recording
      const SpeechCtor = getBrowserSpeechRecognitionCtor();
      if (SpeechCtor) {
        try {
          const sr = new SpeechCtor();
          sr.continuous = true;
          sr.interimResults = true;
          sr.lang = "en-US";
          sr.onresult = (ev) => {
            let full = "";
            for (let i = 0; i < ev.results.length; i++) {
              full += ` ${ev.results[i]?.[0]?.transcript ?? ""}`;
            }
            recBrowserSpeechRef.current = full.trim();
          };
          sr.onerror = () => {
            // Non-blocking fallback
          };
          recRecognitionRef.current = sr;
          sr.start();
        } catch {
          recRecognitionRef.current = null;
        }
      }

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recChunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        try {
          recRecognitionRef.current?.stop();
        } catch {
          // Ignore
        }
        recRecognitionRef.current = null;
        stream.getTracks().forEach((t) => t.stop());
        recStreamRef.current = null;
        setRecMicStream(null);
        const blob = new Blob(recChunksRef.current, { type: mimeType });
        const fallbackSpeech = recBrowserSpeechRef.current;
        recChunksRef.current = [];
        if (blob.size < 100) {
          if (fallbackSpeech) {
            setTranscriptText(fallbackSpeech);
          }
          setRecState("idle");
          return;
        }
        void runTranscriptionBlob(blob, mimeType, fallbackSpeech);
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone permission denied.";
      setTranscribeError(msg);
      toast.error(msg);
    }
  }

  function handleUploadAudioFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void runTranscriptionBlob(file, file.type || "audio/mp3");
  }

  async function handleCopyTranscript() {
    if (!transcriptText.trim()) return;
    try {
      await navigator.clipboard.writeText(transcriptText);
      toast.success("Copied transcript to clipboard.");
    } catch {
      toast.error("Clipboard access blocked.");
    }
  }

  async function handleSendTranscriptToCletus() {
    const trimmed = transcriptText.trim();
    if (!trimmed) return;
    const res = await issueDecree(trimmed);
    if (res.ok) {
      toast.success("Dispatched transcribed directive to Cletus.");
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col divide-y divide-border overflow-auto">
      {/* Section 1: Direct Spoken Conversation with Cletus */}
      <div className="flex flex-col gap-2.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <D3SpeechWaveform
                variant="badge"
                speaking={speaking}
                active={liveState === "connected" || sendingDirect}
                tone={
                  liveState === "error"
                    ? "crit"
                    : speaking
                      ? "ok"
                      : liveState === "connecting" || sendingDirect
                        ? "warn"
                        : "mute"
                }
                analyserRef={outputAnalyserRef}
                boundarySignalRef={boundarySignalRef}
                data-testid="cletus-voice-badge-waveform"
              />
              <p className="text-xs font-medium text-foreground">
                Direct Voice · {vitals.name} ({vitals.sigil})
              </p>
            </div>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {activeMission ? `Mission: ${activeMission.title}` : "Idle Self-Evolution"} · Bridge-synced ·{" "}
              {speaking ? "speaking" : liveState}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <MicLevelIndicator
              active={isMicActive}
              level={micLevel}
              muted={isMicMuted}
              compact
            />

            <select
              aria-label="Select Live Voice persona"
              value={voiceName}
              disabled={liveState === "connecting" || liveState === "connected"}
              onChange={(e) => setVoiceName(e.target.value as LiveVoicePreset)}
              className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground disabled:opacity-50"
            >
              {LIVE_VOICE_PRESETS.map((v) => (
                <option key={v} value={v}>
                  Voice: {v}
                </option>
              ))}
            </select>

            <Button
              type="button"
              variant={speaking ? "destructive" : "outline"}
              size="sm"
              onClick={handleVoiceOutputCheck}
              aria-label={speaking ? "Stop audio playback" : "Test Cletus voice audio waveform"}
              className="h-7 whitespace-nowrap shrink-0 px-2 font-mono text-[11px]"
            >
              {speaking ? <Square className="size-3" /> : <Volume2 className="size-3.5" />}
              <span>{speaking ? "Stop Audio" : "Test Voice"}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setBrowserTtsEnabled((v) => !v)}
              aria-label={browserTtsEnabled ? "Disable browser spoken fallback" : "Enable browser spoken fallback"}
              title={browserTtsEnabled ? "Browser voice fallback enabled" : "Browser voice fallback muted"}
              className="size-7"
            >
              {browserTtsEnabled ? <Volume2 className="size-3.5 text-ok" /> : <VolumeX className="size-3.5 text-muted-foreground" />}
            </Button>

            {liveState === "connected" || liveState === "connecting" ? (
              <>
                <Button
                  type="button"
                  variant={muted ? "destructive" : "outline"}
                  size="icon-sm"
                  onClick={() => setMuted((m) => !m)}
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  className={cn("size-7", !muted && liveState === "connected" && "mic-listening-ring")}
                >
                  {muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={disconnectLiveSession}
                  className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
                >
                  <PhoneOff className="size-3.5" />
                  <span>End Live</span>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => void startLiveSession()}
                className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
              >
                <PhoneCall className="size-3.5" />
                <span>Connect Live</span>
              </Button>
            )}
          </div>
        </div>

        {/* Real-time D3 frequency-based waveform visualizer reacting to Cletus generated speech */}
        <D3SpeechWaveform
          variant="stage"
          speaking={speaking}
          active={liveState === "connected" || sendingDirect}
          tone={liveState === "error" ? "crit" : "ok"}
          analyserRef={outputAnalyserRef}
          boundarySignalRef={boundarySignalRef}
          label={`${vitals.name} · ${voiceName}`}
          sublabel={speaking ? "95Hz–5.6kHz" : liveState === "connected" ? "duplex link" : "output stage"}
          data-testid="cletus-speech-waveform"
        />

        {!nvidiaConfigured ? (
          <div className="rounded border border-warn/35 bg-warn/10 px-2.5 py-1.5 font-mono text-[10px] text-warn">
            NVIDIA_API_KEY missing on server — live NIM speech synthesis unavailable until configured; mic capture &amp; UI controls remain active.
          </div>
        ) : ttsNotice ? (
          <div className="rounded border border-border bg-secondary/40 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
            {ttsNotice}
          </div>
        ) : null}

        {liveError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">{liveError}</p>
          </div>
        ) : null}

        <div
          ref={transcriptScrollRef}
          data-testid="cletus-voice-transcript"
          className="h-36 space-y-1.5 overflow-auto rounded border border-border bg-term p-2.5 font-mono text-[11px]"
        >
          {displayedTranscript.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-muted-foreground">
              Connect Live Mic or send a message below to speak directly with Cletus (synced to Operator Bridge &amp; Activity Log).
            </div>
          ) : (
            displayedTranscript.map((line) => (
              <div key={line.id} className="leading-relaxed">
                <span
                  className={cn(
                    "font-semibold mr-1.5",
                    line.speaker === "operator"
                      ? "text-warn"
                      : line.speaker === "cletus"
                        ? "text-ok"
                        : "text-muted-foreground",
                  )}
                >
                  {line.speaker === "operator"
                    ? "YOU:"
                    : line.speaker === "cletus"
                      ? "CLETUS:"
                      : "SYS:"}
                </span>
                <span className="text-foreground/90">{line.text}</span>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSendDirectToCletus} className="flex items-center gap-1.5">
          <Input
            value={liveTextDraft}
            onChange={(e) => setLiveTextDraft(e.target.value)}
            placeholder={
              liveState === "connected"
                ? "Speak or type directly to Cletus (live WS)…"
                : "Ask or instruct Cletus directly (returns spoken reply & runs tools)…"
            }
            aria-label="Speak or send direct message to Cletus"
            disabled={sendingDirect}
            className="h-7 flex-1 bg-term text-xs"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={sendingDirect || !liveTextDraft.trim()}
            className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
          >
            {sendingDirect ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            <span>{liveState === "connected" ? "Speak Turn" : "Talk to Cletus"}</span>
          </Button>
        </form>
      </div>

      {/* Section 2: Audio Transcription & Mic Meter (Parakeet ASR + Browser Speech Fallback) */}
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <D3SpeechWaveform
                variant="badge"
                active={isMicActive && !isMicMuted}
                tone={recState === "recording" ? "warn" : "mute"}
                analyser={micTelemetry.analyser}
                data-testid="asr-capture-badge-waveform"
              />
              <span>Voice Capture &amp; ASR · nvidia/parakeet-ctc-1.1b-asr</span>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground">
              Record microphone speech or upload audio to transcribe &amp; dispatch to Cletus
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleUploadAudioFile}
              className="hidden"
              aria-label="Upload audio file for transcription"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={recState !== "idle"}
              onClick={() => fileInputRef.current?.click()}
              className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
            >
              <FileAudio className="size-3.5" />
              <span>Upload Audio</span>
            </Button>

            <Button
              type="button"
              variant={recState === "recording" ? "destructive" : "default"}
              size="sm"
              disabled={recState === "transcribing"}
              onClick={() => void toggleStandaloneRecording()}
              className={cn(
                "h-7 whitespace-nowrap shrink-0 px-2.5 text-xs tabular-nums",
                recState === "recording" && "mic-listening-ring",
              )}
            >
              {recState === "transcribing" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Transcribing</span>
                </>
              ) : recState === "recording" ? (
                <>
                  <Square className="size-3" />
                  <span>Stop ({recSeconds}s)</span>
                </>
              ) : (
                <>
                  <Mic className="size-3.5" />
                  <span>Record</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {recState === "recording" ? (
          <MicLevelIndicator active level={micLevel} label={`Listening · ${recSeconds}s`} />
        ) : null}

        {asrNotice ? (
          <div className="rounded border border-warn/35 bg-warn/10 px-2.5 py-1.5 font-mono text-[10px] text-warn">
            {asrNotice}
          </div>
        ) : null}

        {transcribeError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">{transcribeError}</p>
          </div>
        ) : null}

        <textarea
          aria-label="Transcribed audio output"
          value={transcriptText}
          onChange={(e) => setTranscriptText(e.target.value)}
          placeholder="Transcribed speech appears here. Edit or dispatch directly to Cletus…"
          rows={4}
          className="min-h-[84px] flex-1 resize-none rounded border border-border bg-term p-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!transcriptText.trim()}
            onClick={() => void handleCopyTranscript()}
            className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
          >
            <Copy className="size-3" />
            <span>Copy</span>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!transcriptText.trim()}
            onClick={() => void handleSendTranscriptToCletus()}
            className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
          >
            <Send className="size-3" />
            <span>Dispatch to Cletus</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
