import type { Sql } from "@/lib/db";
import { nid } from "./format";
import {
  buildMissionContextSummary,
  formatNvidiaError,
  normalizeNvidiaChatHistory,
  normalizeVideoAspectRatio,
  normalizeVideoDuration,
  NVIDIA_ASR_MODEL,
  NVIDIA_PRIMARY_MODEL,
  NVIDIA_VIDEO_MODEL,
  resolveChatRequestModel,
  resolveSystemRoleInstruction,
} from "./nvidia-inference";
import { readSnapshotFromDb } from "./seed.server";
import {
  callNvidiaAsrWithFallback,
  callNvidiaChatCompletions,
  getNvidiaConfig,
  runMapsGroundingResearch,
  runWebGroundingResearch,
  type NvidiaChatMessageParam,
} from "./tools.server";
import type {
  GeoGroundingPlace,
  InferenceGroundingMode,
  NvidiaChatMessage,
  NvidiaChatModelId,
  NvidiaVideoJob,
  VideoAspectRatio,
  VideoDuration,
  WebGroundingSource,
} from "./types";

function safeParseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function getChatMessages(
  sql: Sql,
  threadId = "default",
): Promise<NvidiaChatMessage[]> {
  const rows = await sql<{
    id: string;
    thread_id: string;
    role: string;
    model: string;
    grounding_mode: string;
    system_role: string;
    content: string;
    web_sources_json: string;
    maps_places_json: string;
    created_at: number;
  }>`
    SELECT * FROM cletus_chat_messages
    WHERE thread_id = ${threadId}
    ORDER BY created_at ASC
    LIMIT 120
  `;

  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    role: r.role === "model" ? "model" : "user",
    model: r.model,
    groundingMode:
      r.grounding_mode === "search" || r.grounding_mode === "maps" ? r.grounding_mode : "none",
    systemRole: r.system_role,
    content: r.content,
    webSources: safeParseJsonArray<WebGroundingSource>(r.web_sources_json),
    mapsPlaces: safeParseJsonArray<GeoGroundingPlace>(r.maps_places_json),
    createdAt: Number(r.created_at),
  }));
}

export async function clearChatMessages(sql: Sql, threadId = "default"): Promise<void> {
  await sql`DELETE FROM cletus_chat_messages WHERE thread_id = ${threadId}`;
  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (${nid("log")}, ${Date.now()}, 'info', 'chat', ${`cleared NVIDIA NIM chat thread ${threadId}`})
  `;
}

export async function sendNvidiaChatTurn(
  sql: Sql,
  input: {
    threadId?: string;
    message: string;
    model: NvidiaChatModelId;
    systemRole: string;
    customSystemInstruction?: string;
    groundingMode: InferenceGroundingMode;
    includeMissionContext?: boolean;
    latLng?: { latitude: number; longitude: number };
  },
): Promise<{
  ok: boolean;
  messages: NvidiaChatMessage[];
  reply?: NvidiaChatMessage;
  modelUsed: string;
  error?: string;
}> {
  const threadId = input.threadId?.trim() || "default";
  const effectiveModel = resolveChatRequestModel(input.model);
  const baseInstruction = resolveSystemRoleInstruction(
    input.systemRole === "custom" ? "cletus_mas" : input.systemRole,
  );
  const effectiveInstruction = input.customSystemInstruction?.trim() || baseInstruction;
  const includeContext = input.includeMissionContext !== false;
  const [priorMessages, snapshot] = await Promise.all([
    getChatMessages(sql, threadId),
    includeContext ? readSnapshotFromDb(sql) : Promise.resolve(null),
  ]);

  const systemInstruction = snapshot
    ? `${effectiveInstruction}\n\n${buildMissionContextSummary(snapshot)}`
    : effectiveInstruction;

  try {
    getNvidiaConfig();
    let webSources: WebGroundingSource[] = [];
    let mapsPlaces: GeoGroundingPlace[] = [];
    let text = "";

    if (input.groundingMode === "search") {
      const grounded = await runWebGroundingResearch(input.message);
      webSources = grounded.sources;
      text = grounded.summary;
    } else if (input.groundingMode === "maps") {
      const grounded = await runMapsGroundingResearch(input.message, input.latLng);
      mapsPlaces = grounded.places;
      text = grounded.summary;
    } else {
      const history = normalizeNvidiaChatHistory(priorMessages);
      const messages: NvidiaChatMessageParam[] = [
        { role: "system", content: systemInstruction },
        ...history,
        { role: "user", content: input.message },
      ];
      const completion = await callNvidiaChatCompletions({
        model: effectiveModel,
        messages,
      });
      text = completion.content || "No response text returned by NVIDIA NIM.";
    }

    const userMsgId = nid("msgc");
    const userAt = Date.now();
    const modelMsgId = nid("msgc");
    const modelAt = userAt + 1;

    await sql`
      INSERT INTO cletus_chat_messages (
        id, thread_id, role, model, grounding_mode, system_role,
        content, web_sources_json, maps_places_json, created_at
      ) VALUES (
        ${userMsgId}, ${threadId}, 'user', ${effectiveModel}, ${input.groundingMode},
        ${input.systemRole}, ${input.message}, '[]', '[]', ${userAt}
      )
    `;

    await sql`
      INSERT INTO cletus_chat_messages (
        id, thread_id, role, model, grounding_mode, system_role,
        content, web_sources_json, maps_places_json, created_at
      ) VALUES (
        ${modelMsgId}, ${threadId}, 'model', ${effectiveModel}, ${input.groundingMode},
        ${input.systemRole}, ${text}, ${JSON.stringify(webSources)}, ${JSON.stringify(mapsPlaces)}, ${modelAt}
      )
    `;

    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${modelAt}, ${effectiveModel}, ${input.groundingMode === "none" ? "nvidia_chat" : `grounding_${input.groundingMode}`}, 'chat', 2)
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${modelAt}, 'info', 'chat', ${`${effectiveModel} (${input.groundingMode}) replied · ${webSources.length} web · ${mapsPlaces.length} geo`})
    `;

    const updated = await getChatMessages(sql, threadId);
    const reply = updated.find((m) => m.id === modelMsgId);
    return {
      ok: true,
      messages: updated,
      reply,
      modelUsed: effectiveModel,
    };
  } catch (err) {
    const formatted = formatNvidiaError(err, effectiveModel);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'chat', ${formatted})
    `;
    return {
      ok: false,
      messages: priorMessages,
      modelUsed: effectiveModel,
      error: formatted,
    };
  }
}

export async function runStandaloneGrounding(
  sql: Sql,
  input: {
    mode: "search" | "maps";
    query: string;
    latLng?: { latitude: number; longitude: number };
  },
): Promise<{
  ok: boolean;
  mode: "search" | "maps";
  query: string;
  modelUsed: string;
  summary: string;
  webSources: WebGroundingSource[];
  mapsPlaces: GeoGroundingPlace[];
  error?: string;
}> {
  const now = Date.now();
  try {
    if (input.mode === "search") {
      const res = await runWebGroundingResearch(input.query);
      await sql`
        INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
        VALUES (${nid("spd")}, ${now}, ${NVIDIA_PRIMARY_MODEL}, 'webSearch', 'research', 2)
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'tool', 'grounding', ${`Web search grounding "${input.query.slice(0, 60)}" · ${res.sources.length} sources`})
      `;
      return {
        ok: true,
        mode: "search",
        query: input.query,
        modelUsed: NVIDIA_PRIMARY_MODEL,
        summary: res.summary,
        webSources: res.sources,
        mapsPlaces: [],
      };
    }

    const res = await runMapsGroundingResearch(input.query, input.latLng);
    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${now}, ${NVIDIA_PRIMARY_MODEL}, 'osmNominatim', 'research', 2)
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'grounding', ${`Geo grounding "${input.query.slice(0, 60)}" · ${res.places.length} places`})
    `;
    return {
      ok: true,
      mode: "maps",
      query: input.query,
      modelUsed: NVIDIA_PRIMARY_MODEL,
      summary: res.summary,
      webSources: [],
      mapsPlaces: res.places,
    };
  } catch (err) {
    const formatted = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'grounding', ${formatted})
    `;
    return {
      ok: false,
      mode: input.mode,
      query: input.query,
      modelUsed: NVIDIA_PRIMARY_MODEL,
      summary: "",
      webSources: [],
      mapsPlaces: [],
      error: formatted,
    };
  }
}

export async function transcribeAudioWithNvidia(
  sql: Sql,
  input: {
    audioBase64: string;
    mimeType: string;
    prompt?: string;
  },
): Promise<{
  ok: boolean;
  modelUsed: string;
  text: string;
  error?: string;
}> {
  const model = NVIDIA_ASR_MODEL;
  const now = Date.now();
  try {
    const bytes = Buffer.from(input.audioBase64, "base64");
    const mimeType = input.mimeType || "audio/wav";
    const ext = mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("mp3") || mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("flac")
            ? "flac"
            : "webm";

    const result = await callNvidiaAsrWithFallback({
      bytes: new Uint8Array(bytes),
      mimeType,
      fileName: `recording.${ext}`,
      prompt: input.prompt,
    });
    const text = result.text;
    const modelUsed = result.modelUsed || model;

    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${now}, ${modelUsed}, 'audio_transcribe', 'audio', 1)
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'audio', ${`transcribed audio via ${modelUsed} (${text.length} chars)`})
    `;
    return { ok: true, modelUsed, text };
  } catch (err) {
    const formatted = formatNvidiaError(err, model);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'audio', ${formatted})
    `;
    return { ok: false, modelUsed: model, text: "", error: formatted };
  }
}

export async function listVideoGenerations(sql: Sql): Promise<NvidiaVideoJob[]> {
  const rows = await sql<{
    id: string;
    prompt: string;
    aspect_ratio: string;
    duration: string;
    status: string;
    interaction_id: string | null;
    video_data_url: string | null;
    mime_type: string;
    error: string | null;
    created_at: number;
  }>`
    SELECT * FROM cletus_video_generations
    ORDER BY created_at DESC
    LIMIT 16
  `;

  return rows.map((r) => ({
    id: r.id,
    prompt: r.prompt,
    aspectRatio: normalizeVideoAspectRatio(r.aspect_ratio),
    duration: normalizeVideoDuration(r.duration),
    status: r.status === "completed" ? "completed" : "failed",
    interactionId: r.interaction_id ?? undefined,
    videoDataUrl: r.video_data_url ?? undefined,
    mimeType: r.mime_type || "video/mp4",
    error: r.error ?? undefined,
    createdAt: Number(r.created_at),
  }));
}

export async function generateVideoWithNvidia(
  sql: Sql,
  input: {
    prompt: string;
    aspectRatio?: string;
    duration?: string;
  },
): Promise<{
  ok: boolean;
  job: NvidiaVideoJob;
  jobs: NvidiaVideoJob[];
  error?: string;
}> {
  const model = NVIDIA_VIDEO_MODEL;
  const aspectRatio: VideoAspectRatio = normalizeVideoAspectRatio(input.aspectRatio);
  const duration: VideoDuration = normalizeVideoDuration(input.duration);
  const id = nid("vid");
  const now = Date.now();

  try {
    const { apiKey } = getNvidiaConfig();
    const videoEndpoint = (
      process.env.NVIDIA_VIDEO_URL?.trim() ||
      "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-video-diffusion"
    ).replace(/\/+$/, "");

    const res = await fetch(videoEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        prompt: input.prompt,
        aspect_ratio: aspectRatio,
        duration,
        cfg_scale: 2.5,
        seed: 0,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`NVIDIA Video NIM HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      video?: string;
      url?: string;
      id?: string;
      artifacts?: Array<{ base64?: string; mime_type?: string }>;
    };

    const rawBase64 = payload.video || payload.artifacts?.[0]?.base64;
    const mimeType = payload.artifacts?.[0]?.mime_type || "video/mp4";
    const videoDataUrl = rawBase64
      ? rawBase64.startsWith("data:")
        ? rawBase64
        : `data:${mimeType};base64,${rawBase64}`
      : payload.url || undefined;

    if (!videoDataUrl) {
      throw new Error("NVIDIA Video NIM completed without returning a video payload or URI.");
    }

    const jobRef = payload.id ?? id;
    await sql`
      INSERT INTO cletus_video_generations (
        id, prompt, aspect_ratio, duration, status, interaction_id,
        video_data_url, mime_type, error, created_at
      ) VALUES (
        ${id}, ${input.prompt}, ${aspectRatio}, ${duration}, 'completed',
        ${jobRef}, ${videoDataUrl}, ${mimeType}, ${null}, ${now}
      )
    `;
    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${now}, ${model}, 'video_generate', 'media', 15)
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'video', ${`generated ${aspectRatio} ${duration} video via ${model} (${jobRef})`})
    `;

    const jobs = await listVideoGenerations(sql);
    const job = jobs.find((j) => j.id === id) ?? {
      id,
      prompt: input.prompt,
      aspectRatio,
      duration,
      status: "completed",
      interactionId: jobRef,
      videoDataUrl,
      mimeType,
      createdAt: now,
    };
    return { ok: true, job, jobs };
  } catch (err) {
    const formatted = formatNvidiaError(err, model);
    await sql`
      INSERT INTO cletus_video_generations (
        id, prompt, aspect_ratio, duration, status, interaction_id,
        video_data_url, mime_type, error, created_at
      ) VALUES (
        ${id}, ${input.prompt}, ${aspectRatio}, ${duration}, 'failed',
        ${null}, ${null}, 'video/mp4', ${formatted}, ${now}
      )
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'video', ${formatted})
    `;

    const jobs = await listVideoGenerations(sql);
    const job = jobs.find((j) => j.id === id) ?? {
      id,
      prompt: input.prompt,
      aspectRatio,
      duration,
      status: "failed",
      mimeType: "video/mp4",
      error: formatted,
      createdAt: now,
    };
    return { ok: false, job, jobs, error: formatted };
  }
}
