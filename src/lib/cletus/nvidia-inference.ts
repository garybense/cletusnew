import type {
  CletusSnapshot,
  NvidiaChatModelId,
} from "./types";

export interface NvidiaModelOption {
  id: NvidiaChatModelId;
  label: string;
  tier: string;
  supportsGroundingSynthesis: boolean;
  description: string;
}

export const NVIDIA_PRIMARY_MODEL: NvidiaChatModelId = "nvidia/llama-3.3-nemotron-super-49b-v1";
export const NVIDIA_FAST_MODEL: NvidiaChatModelId = "nvidia/llama-3.1-nemotron-nano-8b-v1";
export const NVIDIA_EMBED_MODEL = "nvidia/nv-embedqa-e5-v5";
export const NVIDIA_ASR_MODEL = "nvidia/parakeet-ctc-1.1b-asr";
export const NVIDIA_TTS_MODEL = "nvidia/magpie-tts-multilingual";
export const NVIDIA_VIDEO_MODEL = "stabilityai/stable-video-diffusion";
export const NVIDIA_ASR_NVCF_URL =
  "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions";
export const NVIDIA_TTS_NVCF_URL =
  "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize";

export const CHAT_MODELS: NvidiaModelOption[] = [
  {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1",
    label: "Nemotron Super 49B",
    tier: "Deep Reasoning & Agent Core",
    supportsGroundingSynthesis: true,
    description: "Primary NVIDIA NIM reasoning, ReAct tool calling, and grounded synthesis",
  },
  {
    id: "meta/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B Instruct",
    tier: "General & Engineering",
    supportsGroundingSynthesis: true,
    description: "Balanced 70B instruction model for architecture & technical analysis",
  },
  {
    id: "deepseek-ai/deepseek-r1",
    label: "DeepSeek-R1 NIM",
    tier: "Formal Reasoning & Audit",
    supportsGroundingSynthesis: true,
    description: "Chain-of-thought formal audit and multi-step decomposition",
  },
  {
    id: "nvidia/llama-3.1-nemotron-nano-8b-v1",
    label: "Nemotron Nano 8B",
    tier: "Low-Latency Triage",
    supportsGroundingSynthesis: true,
    description: "Ultra-fast compact NVIDIA NIM model for rapid checks & fallback",
  },
];

export const CHAT_SYSTEM_ROLES = [
  {
    id: "cletus_mas",
    label: "Cletus MAS Advisor",
    instruction:
      "You are the Cletus Multi-Agent Orchestration Copilot powered by NVIDIA NIM. Ground answers in the live mission snapshot (vitals, credits, DAG tasks, specialist agents, cycles) when relevant. Be concise, accurate, and truthful.",
  },
  {
    id: "research_scout",
    label: "Frontier Research Scout",
    instruction:
      "You are a technical research scout specializing in multi-agent systems, dynamic tool synthesis, and distributed consensus. Cite concrete specifications, APIs, and sources.",
  },
  {
    id: "risk_auditor",
    label: "Treasury & Risk Auditor",
    instruction:
      "You are a deterministic treasury & policy auditor. Scrutinize reserve compliance, failure modes, and acceptance criteria rigorously without speculation.",
  },
] as const;

export const LIVE_VOICE_PRESETS = ["Aria", "Sofia", "Jason", "Leo", "Mia"] as const;
export type LiveVoicePreset = (typeof LIVE_VOICE_PRESETS)[number];

const MAGPIE_VOICE_MAP: Record<LiveVoicePreset, string> = {
  Aria: "Magpie-Multilingual.EN-US.Aria",
  Sofia: "Magpie-Multilingual.EN-US.Sofia",
  Jason: "Magpie-Multilingual.EN-US.Jason",
  Leo: "Magpie-Multilingual.EN-US.Leo",
  Mia: "Magpie-Multilingual.EN-US.Mia",
};

export function resolveNvidiaVoiceName(voiceName?: string): {
  preset: LiveVoicePreset;
  magpieVoice: string;
} {
  const preset = (LIVE_VOICE_PRESETS.find(
    (v) => v.toLowerCase() === String(voiceName ?? "").trim().toLowerCase(),
  ) ?? "Aria") as LiveVoicePreset;
  return {
    preset,
    magpieVoice: MAGPIE_VOICE_MAP[preset],
  };
}

export function resolveChatRequestModel(
  selected: NvidiaChatModelId,
  _groundingMode?: string,
): NvidiaChatModelId {
  return CHAT_MODELS.some((m) => m.id === selected) ? selected : NVIDIA_PRIMARY_MODEL;
}

export function normalizeWorkerModelId(model?: string | null): NvidiaChatModelId {
  if (!model || model.startsWith("gemini")) {
    return model === "gemini-3.1-flash-lite" ? NVIDIA_FAST_MODEL : NVIDIA_PRIMARY_MODEL;
  }
  if (CHAT_MODELS.some((m) => m.id === model)) {
    return model as NvidiaChatModelId;
  }
  return NVIDIA_PRIMARY_MODEL;
}

export function resolveSystemRoleInstruction(
  roleId?: string,
  customInstruction?: string,
): string {
  const custom = customInstruction?.trim();
  if (custom) return custom;
  const found = CHAT_SYSTEM_ROLES.find((r) => r.id === roleId);
  return found ? found.instruction : CHAT_SYSTEM_ROLES[0].instruction;
}

export function buildMissionContextSummary(snapshot: CletusSnapshot): string {
  const activeMission = snapshot.missions.find((m) => m.id === snapshot.vitals.activeMissionId);
  const doneTasks = snapshot.tasks.filter((t) => t.status === "completed").length;
  const openTasks = snapshot.tasks
    .filter((t) => t.status !== "completed")
    .slice(0, 6)
    .map((t) => `- ${t.id} [${t.status}] ${t.title} (${t.assignee})`)
    .join("\n");
  const agents = snapshot.children
    .map((c) => `${c.name} [${c.role}, ${c.status}]`)
    .join("; ");

  return [
    `LIVE CLETUS WORKSPACE CONTEXT (${snapshot.vitals.sigil}):`,
    `- Credits: ${(snapshot.vitals.creditsCents / 100).toFixed(2)} cr | Reserve: ${(snapshot.vitals.reserveCents / 100).toFixed(2)} cr | Tier: ${snapshot.vitals.tier} | Paused: ${snapshot.paused}`,
    activeMission
      ? `- Active Mission (${activeMission.id}, ${activeMission.status}): ${activeMission.title} — ${activeMission.objective}`
      : "- Active Mission: None",
    `- Tasks: ${doneTasks}/${snapshot.tasks.length} completed`,
    openTasks ? `- Open Tasks:\n${openTasks}` : "- Open Tasks: None",
    `- Agents: ${agents || "None"}`,
  ].join("\n");
}

export function normalizeNvidiaChatHistory(
  messages: Array<{ role: string; content: string }>,
  limit = 20,
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .slice(-limit)
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
}

export function normalizeVideoAspectRatio(ratio?: string): "16:9" | "9:16" {
  return ratio === "9:16" ? "9:16" : "16:9";
}

export function normalizeVideoDuration(duration?: string): "5s" | "8s" | "10s" {
  if (duration === "5s" || duration === "8s" || duration === "10s") return duration;
  return "8s";
}

export function normalizeNvidiaBaseUrl(baseUrl?: string | null): string {
  const clean = (baseUrl?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  return clean.replace(
    /\/(?:chat\/completions|completions|embeddings|models|audio\/transcriptions|audio\/speech)$/i,
    "",
  );
}

export function isHostedNvidiaCatalogBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeNvidiaBaseUrl(baseUrl).toLowerCase();
  return (
    normalized.startsWith("https://integrate.api.nvidia.com") ||
    normalized.startsWith("https://ai.api.nvidia.com")
  );
}

export function resolveNvidiaAsrEndpoint(
  baseUrl: string,
  overrideUrl?: string,
): { url: string; protocol: "nvcf-riva" | "openai-compatible" } {
  const explicit = overrideUrl?.trim().replace(/\/+$/, "");
  if (explicit) {
    return {
      url: explicit,
      protocol: explicit.includes(".invocation.api.nvcf.nvidia.com")
        ? "nvcf-riva"
        : "openai-compatible",
    };
  }
  if (isHostedNvidiaCatalogBaseUrl(baseUrl)) {
    return { url: NVIDIA_ASR_NVCF_URL, protocol: "nvcf-riva" };
  }
  return {
    url: `${baseUrl.trim().replace(/\/+$/, "")}/audio/transcriptions`,
    protocol: "openai-compatible",
  };
}

export function resolveNvidiaTtsEndpoint(
  baseUrl: string,
  overrideUrl?: string,
): { url: string; protocol: "nvcf-multipart" | "openai-json" } {
  const explicit = overrideUrl?.trim().replace(/\/+$/, "");
  if (explicit) {
    return {
      url: explicit,
      protocol:
        explicit.includes(".invocation.api.nvcf.nvidia.com") || explicit.endsWith("/synthesize")
          ? "nvcf-multipart"
          : "openai-json",
    };
  }
  if (isHostedNvidiaCatalogBaseUrl(baseUrl)) {
    return { url: NVIDIA_TTS_NVCF_URL, protocol: "nvcf-multipart" };
  }
  return {
    url: `${baseUrl.trim().replace(/\/+$/, "")}/audio/speech`,
    protocol: "openai-json",
  };
}

export function formatNvidiaError(err: unknown, model?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("nvidia_api_key") ||
    (lower.includes("missing") && lower.includes("api_key")) ||
    lower.includes("401") ||
    lower.includes("unauthorized")
  ) {
    return "Server NVIDIA_API_KEY is missing or unauthorized. Add a valid NVIDIA NIM API key in Settings > Secrets.";
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return `NVIDIA NIM access denied for model '${model ?? NVIDIA_PRIMARY_MODEL}'. Check your NVIDIA NGC API key entitlements (${raw}).`;
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return `NVIDIA NIM model '${model ?? NVIDIA_PRIMARY_MODEL}' was not found on the configured endpoint (${raw}).`;
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    return `NVIDIA NIM rate limit or credit quota reached for '${model ?? NVIDIA_PRIMARY_MODEL}'. Retry shortly.`;
  }
  return raw;
}

/**
 * Downsample Float32 PCM from browser AudioContext rate (e.g. 44100/48000 Hz) to 16000 Hz.
 */
export function downsampleFloat32(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000,
): Float32Array {
  if (targetSampleRate >= inputSampleRate || inputSampleRate <= 0) {
    return input;
  }
  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i]!;
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function float32ToPcm16Base64(float32: Float32Array): string {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLength = binary.length;
  const sampleCount = Math.floor(byteLength / 2);
  const float32 = new Float32Array(sampleCount);
  const buffer = new ArrayBuffer(sampleCount * 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < sampleCount * 2; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(buffer);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

export function mixAudioChannelsToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]!.length;
  const mono = new Float32Array(length);
  const count = channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < count; c++) {
      sum += channels[c]![i] ?? 0;
    }
    mono[i] = sum / count;
  }
  return mono;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeFloat32ToWavBytes(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const pcmByteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + pcmByteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmByteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmByteLength, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}
