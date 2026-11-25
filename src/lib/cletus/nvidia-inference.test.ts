import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMissionContextSummary,
  CHAT_MODELS,
  CHAT_SYSTEM_ROLES,
  downsampleFloat32,
  encodeFloat32ToWavBytes,
  float32ToPcm16Base64,
  formatNvidiaError,
  LIVE_VOICE_PRESETS,
  mixAudioChannelsToMono,
  normalizeNvidiaBaseUrl,
  normalizeNvidiaChatHistory,
  normalizeVideoAspectRatio,
  normalizeVideoDuration,
  normalizeWorkerModelId,
  NVIDIA_ASR_NVCF_URL,
  NVIDIA_FAST_MODEL,
  NVIDIA_PRIMARY_MODEL,
  NVIDIA_TTS_NVCF_URL,
  pcm16Base64ToFloat32,
  resolveChatRequestModel,
  resolveNvidiaAsrEndpoint,
  resolveNvidiaTtsEndpoint,
  resolveNvidiaVoiceName,
  resolveSystemRoleInstruction,
} from "./nvidia-inference";
import type { CletusSnapshot } from "./types";

describe("NVIDIA NIM models, voices & role resolution", () => {
  it("exposes all four required NVIDIA NIM chat models", () => {
    const ids = CHAT_MODELS.map((m) => m.id);
    assert.deepEqual(ids, [
      "nvidia/llama-3.3-nemotron-super-49b-v1",
      "meta/llama-3.3-70b-instruct",
      "deepseek-ai/deepseek-r1",
      "nvidia/llama-3.1-nemotron-nano-8b-v1",
    ]);
  });

  it("preserves valid NVIDIA chat model selections and falls back safely", () => {
    assert.equal(
      resolveChatRequestModel("nvidia/llama-3.3-nemotron-super-49b-v1", "search"),
      "nvidia/llama-3.3-nemotron-super-49b-v1",
    );
    assert.equal(
      resolveChatRequestModel("deepseek-ai/deepseek-r1", "none"),
      "deepseek-ai/deepseek-r1",
    );
    assert.equal(
      resolveChatRequestModel("meta/llama-3.3-70b-instruct", "maps"),
      "meta/llama-3.3-70b-instruct",
    );
    assert.equal(
      resolveChatRequestModel("nvidia/llama-3.1-nemotron-nano-8b-v1", "none"),
      "nvidia/llama-3.1-nemotron-nano-8b-v1",
    );
  });

  it("normalizes worker model IDs to NVIDIA NIM models", () => {
    assert.equal(normalizeWorkerModelId(null), NVIDIA_PRIMARY_MODEL);
    assert.equal(normalizeWorkerModelId("gemini-4-hydrogen"), NVIDIA_PRIMARY_MODEL);
    assert.equal(normalizeWorkerModelId("gemini-3.1-flash-lite"), NVIDIA_FAST_MODEL);
    assert.equal(normalizeWorkerModelId("meta/llama-3.3-70b-instruct"), "meta/llama-3.3-70b-instruct");
    assert.equal(normalizeWorkerModelId("unknown-model"), NVIDIA_PRIMARY_MODEL);
  });

  it("maps Magpie TTS voice presets cleanly and defaults to Aria", () => {
    assert.deepEqual([...LIVE_VOICE_PRESETS], ["Aria", "Sofia", "Jason", "Leo", "Mia"]);
    assert.deepEqual(resolveNvidiaVoiceName("Sofia"), {
      preset: "Sofia",
      magpieVoice: "Magpie-Multilingual.EN-US.Sofia",
    });
    assert.deepEqual(resolveNvidiaVoiceName("unknown"), {
      preset: "Aria",
      magpieVoice: "Magpie-Multilingual.EN-US.Aria",
    });
  });

  it("resolves system role presets and honors custom instructions", () => {
    const auditor = CHAT_SYSTEM_ROLES.find((r) => r.id === "risk_auditor")!;
    assert.equal(resolveSystemRoleInstruction("risk_auditor"), auditor.instruction);
    assert.equal(resolveSystemRoleInstruction("risk_auditor", "Custom directive"), "Custom directive");
  });

  it("normalizes chat history to OpenAI-compatible user/assistant messages", () => {
    const history = normalizeNvidiaChatHistory([
      { role: "model", content: "legacy assistant turn" },
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "nvidia reply" },
      { role: "user", content: "   " },
    ]);
    assert.deepEqual(history, [
      { role: "assistant", content: "legacy assistant turn" },
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "nvidia reply" },
    ]);
  });

  it("builds concise live mission control context summary", () => {
    const summary = buildMissionContextSummary({
      vitals: {
        name: "Cletus",
        state: "running",
        model: NVIDIA_PRIMARY_MODEL,
        creditsCents: 18420,
        usdcCents: 1240,
        reserveCents: 1000,
        turns: 12,
        startedAt: 0,
        sleepUntil: null,
        tier: "normal",
        creator: "abc",
        sigil: "CLETUS-CORE-01",
        activeMissionId: "msn_1",
        activeDomain: "mas_rnd",
        autoLoop: false,
        creditsSyntheticOverride: false,
      },
      paused: false,
      missions: [
        {
          id: "msn_1",
          title: "Verify Autonomous Mesh",
          objective: "Test end-to-end orchestration",
          status: "active",
          orchestrator: "Orchestrator-Prime",
          successCriteria: "All tasks done",
          cycleCount: 3,
          maxCycles: 12,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      tasks: [
        {
          id: "tsk_1",
          goalId: "gol_1",
          title: "Run NVIDIA grounded synthesis",
          status: "running",
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
          createdAt: 0,
        },
      ],
      children: [
        {
          id: "agt_1",
          name: "Orchestrator-Prime",
          kind: "local",
          status: "healthy",
          role: "orchestrator",
          lastBeatAgoMs: 1000,
          capabilities: [],
          cycleCount: 5,
        },
      ],
    } as unknown as CletusSnapshot);

    assert.match(summary, /CLETUS-CORE-01/);
    assert.match(summary, /184\.20 cr/);
    assert.match(summary, /Verify Autonomous Mesh/);
    assert.match(summary, /tsk_1 \[running\]/);
  });
});

describe("NVIDIA Video Studio parameter normalization & error surfacing", () => {
  it("normalizes 16:9 and 9:16 aspect ratios and durations", () => {
    assert.equal(normalizeVideoAspectRatio("9:16"), "9:16");
    assert.equal(normalizeVideoAspectRatio("16:9"), "16:9");
    assert.equal(normalizeVideoAspectRatio("4:3"), "16:9");
    assert.equal(normalizeVideoDuration("5s"), "5s");
    assert.equal(normalizeVideoDuration("10s"), "10s");
    assert.equal(normalizeVideoDuration("99s"), "8s");
  });

  it("adds Settings > Secrets and NGC guidance on key/entitlement/rate failures", () => {
    const missingKey = formatNvidiaError(
      new Error("401 Unauthorized: missing NVIDIA_API_KEY"),
      NVIDIA_PRIMARY_MODEL,
    );
    assert.match(missingKey, /NVIDIA_API_KEY/);
    assert.match(missingKey, /Settings > Secrets/);

    const denied = formatNvidiaError(
      new Error("403 Forbidden: entitlement required"),
      "deepseek-ai/deepseek-r1",
    );
    assert.match(denied, /deepseek-ai\/deepseek-r1/);
    assert.match(denied, /NGC/);
  });
});

describe("PCM16 audio encoding, decoding & downsampling", () => {
  it("roundtrips Float32 samples through 16-bit LE PCM base64", () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.99, -0.99]);
    const encoded = float32ToPcm16Base64(input);
    const decoded = pcm16Base64ToFloat32(encoded);
    assert.equal(decoded.length, input.length);
    for (let i = 0; i < input.length; i++) {
      assert.ok(Math.abs(decoded[i]! - input[i]!) < 0.001);
    }
  });

  it("downsamples 48kHz audio cleanly to 16kHz", () => {
    const src = new Float32Array(480);
    src.fill(0.25);
    const dst = downsampleFloat32(src, 48000, 16000);
    assert.equal(dst.length, 160);
    assert.ok(Math.abs(dst[0]! - 0.25) < 0.0001);
  });

  it("mixes stereo Float32 channels to mono and writes a valid 16kHz PCM WAV header", () => {
    const left = new Float32Array([0.5, -0.5]);
    const right = new Float32Array([0.1, -0.3]);
    const mono = mixAudioChannelsToMono([left, right]);
    assert.equal(mono.length, 2);
    assert.ok(Math.abs(mono[0]! - 0.3) < 0.0001);
    assert.ok(Math.abs(mono[1]! - -0.4) < 0.0001);

    const wav = encodeFloat32ToWavBytes(mono, 16000);
    assert.equal(wav.length, 44 + 4);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(view.getUint32(40, true), 4);
  });
});

describe("NVIDIA ASR & TTS NVCF endpoint resolution", () => {
  it("routes default NVIDIA catalog endpoints to NVCF Parakeet ASR and Magpie TTS URLs", () => {
    assert.deepEqual(resolveNvidiaAsrEndpoint("https://integrate.api.nvidia.com/v1"), {
      url: NVIDIA_ASR_NVCF_URL,
      protocol: "nvcf-riva",
    });
    assert.deepEqual(resolveNvidiaAsrEndpoint("https://ai.api.nvidia.com/v1"), {
      url: NVIDIA_ASR_NVCF_URL,
      protocol: "nvcf-riva",
    });
    assert.deepEqual(resolveNvidiaTtsEndpoint("https://integrate.api.nvidia.com/v1"), {
      url: NVIDIA_TTS_NVCF_URL,
      protocol: "nvcf-multipart",
    });
  });

  it("preserves custom proxy URLs and explicit ASR/TTS overrides", () => {
    assert.deepEqual(resolveNvidiaAsrEndpoint("http://localhost:9000/v1"), {
      url: "http://localhost:9000/v1/audio/transcriptions",
      protocol: "openai-compatible",
    });
    assert.deepEqual(
      resolveNvidiaAsrEndpoint(
        "https://integrate.api.nvidia.com/v1",
        "https://custom-asr.internal/v1/audio/transcriptions/",
      ),
      {
        url: "https://custom-asr.internal/v1/audio/transcriptions",
        protocol: "openai-compatible",
      },
    );
    assert.deepEqual(resolveNvidiaTtsEndpoint("http://localhost:9000/v1"), {
      url: "http://localhost:9000/v1/audio/speech",
      protocol: "openai-json",
    });
    assert.deepEqual(
      resolveNvidiaTtsEndpoint(
        "http://localhost:9000/v1",
        "https://custom.invocation.api.nvcf.nvidia.com/v1/audio/synthesize",
      ),
      {
        url: "https://custom.invocation.api.nvcf.nvidia.com/v1/audio/synthesize",
        protocol: "nvcf-multipart",
      },
    );
  });

  it("normalizes NVIDIA_BASE_URL when configured with trailing /chat/completions or /models", () => {
    assert.equal(
      normalizeNvidiaBaseUrl("https://integrate.api.nvidia.com/v1/chat/completions/"),
      "https://integrate.api.nvidia.com/v1",
    );
    assert.equal(
      normalizeNvidiaBaseUrl("https://integrate.api.nvidia.com/v1/models"),
      "https://integrate.api.nvidia.com/v1",
    );
    assert.deepEqual(
      resolveNvidiaAsrEndpoint(normalizeNvidiaBaseUrl("https://integrate.api.nvidia.com/v1/chat/completions")),
      {
        url: NVIDIA_ASR_NVCF_URL,
        protocol: "nvcf-riva",
      },
    );
  });
});
