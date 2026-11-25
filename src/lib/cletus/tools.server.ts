import type { Sql } from "@/lib/db";
import { computeHorizonForMaturity } from "./evolution";
import { nid } from "./format";
import { reconcileAndPersistLifecycle } from "./heartbeat.server";
import {
  canTransitionTaskStatus,
  renderUrlTemplate,
  validateAndNormalizePlan,
  validatePublicHttpsUrl,
  wouldCreateTaskCycle,
} from "./mas-engine";
import {
  NVIDIA_ASR_MODEL,
  NVIDIA_ASR_NVCF_URL,
  NVIDIA_EMBED_MODEL,
  NVIDIA_FAST_MODEL,
  NVIDIA_PRIMARY_MODEL,
  normalizeNvidiaBaseUrl,
  normalizeWorkerModelId,
  resolveNvidiaAsrEndpoint,
} from "./nvidia-inference";
import { evaluateToolPolicy } from "./policy.server";
import { recordTaskEvent } from "./task-history.server";
import type {
  CletusSnapshot,
  DynamicTool,
  EvolutionActionKind,
  EvolutionTrajectorySlug,
  GeoGroundingPlace,
  JsonObject,
  Task,
  TaskStatus,
  WebGroundingSource,
} from "./types";

export const AGENT_MODEL = NVIDIA_PRIMARY_MODEL;
export const FALLBACK_AGENT_MODEL = NVIDIA_FAST_MODEL;

const MODERN_NVIDIA_CHAT_FALLBACKS = [
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-bolt-e4b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "mistralai/mistral-large-4-1t-a52b",
] as const;

let discoveredModelCache: { baseUrl: string; expiresAt: number; models: string[] } | null = null;

export interface NvidiaToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface NvidiaChatMessageParam {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: NvidiaToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface NvidiaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function getNvidiaConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is not configured on the server. Add NVIDIA_API_KEY in Settings > Secrets to execute NVIDIA NIM inference.",
    );
  }
  const baseUrl = normalizeNvidiaBaseUrl(process.env.NVIDIA_BASE_URL);
  return { apiKey, baseUrl };
}

function getCandidateBaseUrls(baseUrl: string): string[] {
  const clean = baseUrl.replace(/\/+$/, "");
  if (clean.endsWith("/v1")) return [clean];
  return [clean, `${clean}/v1`];
}

function rankChatModelCandidate(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes("nemotron-3.5-super")) return 1;
  if (lower.includes("nemotron-3.5-lightning")) return 2;
  if (lower.includes("nemotron-3.5-bolt")) return 3;
  if (lower.includes("nemotron-3-nano-omni")) return 4;
  if (lower.includes("nemotron-3-ultra")) return 5;
  if (lower.includes("mistral-large")) return 6;
  if (lower.includes("nemotron")) return 7;
  if (lower.includes("llama")) return 8;
  return 12;
}

async function discoverLiveChatModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const now = Date.now();
  if (
    discoveredModelCache &&
    discoveredModelCache.baseUrl === baseUrl &&
    discoveredModelCache.expiresAt > now
  ) {
    return discoveredModelCache.models;
  }

  for (const candidateBase of getCandidateBaseUrls(baseUrl)) {
    try {
      const res = await fetch(`${candidateBase}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "Cletus-Enterprise-MAS/1.0",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (json.data ?? [])
        .map((item) => item.id?.trim() ?? "")
        .filter((id) => {
          if (!id) return false;
          const l = id.toLowerCase();
          return (
            !l.includes("embed") &&
            !l.includes("guard") &&
            !l.includes("safety") &&
            !l.includes("retriever") &&
            !l.includes("rerank") &&
            !l.includes("parse") &&
            !l.includes("reward") &&
            !l.includes("detector") &&
            !l.includes("nvclip") &&
            !l.includes("pii")
          );
        })
        .sort((a, b) => rankChatModelCandidate(a) - rankChatModelCandidate(b))
        .slice(0, 8);

      if (models.length > 0) {
        discoveredModelCache = { baseUrl, expiresAt: now + 5 * 60_000, models };
        return models;
      }
    } catch {
      // Try next base URL
    }
  }
  return [];
}

function isTransientNvidiaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("rate limit") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed") ||
    msg.includes("TimeoutError")
  );
}

function shouldFallbackNvidiaModel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    isTransientNvidiaError(err) ||
    msg.includes("http 410") ||
    msg.includes("http 404") ||
    msg.includes("http 403") ||
    msg.includes("gone") ||
    msg.includes("decommissioned") ||
    msg.includes("end of life") ||
    msg.includes("not found")
  );
}

function isToolSchemaRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    (msg.includes("http 400") || msg.includes("http 422")) &&
    (msg.includes("tool") || msg.includes("function"))
  );
}

export async function callNvidiaChatCompletions(params: {
  model?: string | null;
  messages: NvidiaChatMessageParam[];
  tools?: NvidiaToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{
  content: string;
  toolCalls: NvidiaToolCall[];
  modelUsed: string;
  fellBack: boolean;
}> {
  const { apiKey, baseUrl } = getNvidiaConfig();
  const primary = normalizeWorkerModelId(params.model);
  const candidates: string[] = Array.from(
    new Set([
      primary,
      ...MODERN_NVIDIA_CHAT_FALLBACKS,
      "meta/llama-3.3-70b-instruct",
      FALLBACK_AGENT_MODEL,
    ]),
  );
  const seenCandidates = new Set(candidates);
  const baseUrls = getCandidateBaseUrls(baseUrl);
  let discoveredInjected = false;
  let lastErr: unknown;

  for (let mIdx = 0; mIdx < candidates.length; mIdx++) {
    const model = candidates[mIdx]!;
    let includeTools = Boolean(params.tools && params.tools.length > 0);
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let routeHandled = false;
      for (const activeBase of baseUrls) {
        try {
          const body: Record<string, unknown> = {
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.2,
            max_tokens: params.maxTokens ?? 1800,
            stream: false,
          };
          if (includeTools && params.tools && params.tools.length > 0) {
            body.tools = params.tools;
            body.tool_choice = "auto";
          }

          const res = await fetch(`${activeBase}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "User-Agent": "Cletus-Enterprise-MAS/1.0",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(45_000),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(
              `NVIDIA NIM HTTP ${res.status} (${model} @ ${activeBase}/chat/completions): ${errText.slice(0, 240)}`,
            );
          }

          const json = (await res.json()) as {
            choices?: Array<{
              message?: {
                content?: string | null;
                tool_calls?: Array<{
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };

          const msg = json.choices?.[0]?.message;
          const toolCalls: NvidiaToolCall[] = (msg?.tool_calls ?? [])
            .filter((tc) => tc.function?.name)
            .map((tc, idx) => ({
              id: tc.id || `call_${Date.now()}_${idx}`,
              type: "function",
              function: {
                name: String(tc.function!.name),
                arguments: String(tc.function!.arguments ?? "{}"),
              },
            }));

          return {
            content: String(msg?.content ?? "").trim(),
            toolCalls,
            modelUsed: model,
            fellBack: mIdx > 0,
          };
        } catch (err) {
          lastErr = err;
          if (includeTools && isToolSchemaRejection(err)) {
            includeTools = false;
            routeHandled = true;
            break;
          }
          const msgLower = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
          // Try next baseUrl (/v1) when plain /chat/completions returned 404
          if (msgLower.includes("http 404") && activeBase !== baseUrls[baseUrls.length - 1]) {
            continue;
          }
          if (isTransientNvidiaError(err)) {
            if (attempt + 1 < maxAttempts) {
              await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
            }
            routeHandled = true;
            break;
          }
          if (shouldFallbackNvidiaModel(err)) {
            if (!discoveredInjected) {
              discoveredInjected = true;
              const liveModels = await discoverLiveChatModels(apiKey, baseUrl);
              for (const lm of liveModels) {
                if (!seenCandidates.has(lm)) {
                  seenCandidates.add(lm);
                  candidates.push(lm);
                }
              }
            }
            if (mIdx + 1 < candidates.length) {
              routeHandled = false;
              break;
            }
          }
          throw err;
        }
      }
      if (!routeHandled) {
        break;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function callNvidiaAsrWithFallback(params: {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
  prompt?: string;
}): Promise<{ text: string; modelUsed: string }> {
  const { apiKey, baseUrl } = getNvidiaConfig();
  const explicitOverride = process.env.NVIDIA_ASR_URL?.trim();
  const primaryTarget = resolveNvidiaAsrEndpoint(baseUrl, explicitOverride);

  const targets: Array<{ url: string; protocol: "nvcf-riva" | "openai-compatible"; model: string }> = [
    { ...primaryTarget, model: NVIDIA_ASR_MODEL },
  ];

  const pushTarget = (t: { url: string; protocol: "nvcf-riva" | "openai-compatible"; model: string }) => {
    if (!targets.some((existing) => existing.url === t.url && existing.model === t.model)) {
      targets.push(t);
    }
  };

  for (const candidateBase of getCandidateBaseUrls(baseUrl)) {
    const compatUrl = `${candidateBase}/audio/transcriptions`;
    for (const modelId of [NVIDIA_ASR_MODEL, "nvidia/parakeet-tdt-0.6b-v2", "whisper-1"]) {
      pushTarget({ url: compatUrl, protocol: "openai-compatible", model: modelId });
    }
  }
  pushTarget({ url: NVIDIA_ASR_NVCF_URL, protocol: "nvcf-riva", model: NVIDIA_ASR_MODEL });

  let lastErr: unknown;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(params.bytes)], { type: params.mimeType || "audio/wav" }),
        params.fileName || "recording.wav",
      );
      if (target.protocol === "nvcf-riva") {
        form.append("language", "en-US");
      } else {
        form.append("model", target.model);
        form.append("language", "en");
        if (params.prompt?.trim()) {
          form.append("prompt", params.prompt.trim());
        }
      }

      const res = await fetch(target.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`NVIDIA ASR HTTP ${res.status}: ${errBody.slice(0, 260)}`);
      }
      const json = (await res.json()) as { text?: string };
      return {
        text: (json.text ?? "").trim(),
        modelUsed: target.model,
      };
    } catch (err) {
      lastErr = err;
      if (i + 1 < targets.length && shouldFallbackNvidiaModel(err)) {
        continue;
      }
      if (!shouldFallbackNvidiaModel(err)) {
        throw err;
      }
    }
  }

  // Fallback to NVIDIA NIM multimodal Omni chat completion when NVCF Riva ASR returns 403/404
  const audioFormat = params.mimeType.includes("mp3") || params.mimeType.includes("mpeg")
    ? "mp3"
    : "wav";
  const base64Audio = Buffer.from(params.bytes).toString("base64");
  const omniModel = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
  for (const candidateBase of getCandidateBaseUrls(baseUrl)) {
    try {
      const res = await fetch(`${candidateBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "Cletus-Enterprise-MAS/1.0",
        },
        body: JSON.stringify({
          model: omniModel,
          temperature: 0.1,
          max_tokens: 600,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: params.prompt?.trim()
                    ? `Transcribe the spoken audio verbatim. Return only the transcription text. Context: ${params.prompt.trim()}`
                    : "Transcribe the spoken audio verbatim. Return only the transcription text without commentary.",
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: base64Audio,
                    format: audioFormat,
                  },
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const transcript = (json.choices?.[0]?.message?.content ?? "").trim();
        if (transcript) {
          return { text: transcript, modelUsed: omniModel };
        }
      }
    } catch {
      // Fall through to surface original ASR entitlement error cleanly
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function embedTextWithNvidia(
  text: string,
  inputType: "passage" | "query" = "passage",
): Promise<number[] | null> {
  if (!process.env.NVIDIA_API_KEY?.trim()) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const { apiKey, baseUrl } = getNvidiaConfig();
    for (const model of [NVIDIA_EMBED_MODEL, "nvidia/nemotron-3.5-embed-1b", "nvidia/llama-3.2-nv-embedqa-1b-v1"]) {
      for (const candidateBase of getCandidateBaseUrls(baseUrl)) {
        const res = await fetch(`${candidateBase}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: [trimmed.slice(0, 3500)],
            input_type: inputType,
            encoding_format: "float",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const values = data.data?.[0]?.embedding;
        if (Array.isArray(values) && values.length > 0) {
          return values.map(Number);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function queryArxivLive(query: string, maxResults = 5): Promise<{
  ok: boolean;
  query: string;
  count: number;
  papers: Array<{
    id: string;
    title: string;
    authors: string[];
    published: string;
    summary: string;
    url: string;
  }>;
  error?: string;
}> {
  const limit = Math.min(10, Math.max(1, Math.round(maxResults)));
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        query,
        count: 0,
        papers: [],
        error: `arXiv API returned HTTP ${res.status}`,
      };
    }
    const xml = await res.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    const papers = entries.map((entry) => {
      const idMatch = entry.match(/<id>(.*?)<\/id>/);
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const pubMatch = entry.match(/<published>(.*?)<\/published>/);
      const authorMatches = [...entry.matchAll(/<author>\s*<name>(.*?)<\/name>/g)].map((m) =>
        decodeXmlEntities(m[1] ?? ""),
      );
      const rawId = decodeXmlEntities(idMatch?.[1] ?? "");
      return {
        id: rawId.split("/abs/").pop() ?? rawId,
        title: decodeXmlEntities(titleMatch?.[1] ?? "Untitled"),
        authors: authorMatches.slice(0, 4),
        published: decodeXmlEntities(pubMatch?.[1] ?? ""),
        summary: decodeXmlEntities(summaryMatch?.[1] ?? "").slice(0, 420),
        url: rawId,
      };
    });
    return { ok: true, query, count: papers.length, papers };
  } catch (err) {
    return {
      ok: false,
      query,
      count: 0,
      papers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function queryGithubReposLive(query: string, maxResults = 5): Promise<{
  ok: boolean;
  query: string;
  count: number;
  repositories: Array<{
    fullName: string;
    description: string;
    stars: number;
    language: string | null;
    topics: string[];
    updatedAt: string;
    url: string;
  }>;
  error?: string;
}> {
  const limit = Math.min(10, Math.max(1, Math.round(maxResults)));
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Cletus-Enterprise-MAS",
  };
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        query,
        count: 0,
        repositories: [],
        error: `GitHub API returned HTTP ${res.status}: ${body.slice(0, 180)}`,
      };
    }
    const data = (await res.json()) as {
      items?: Array<{
        full_name: string;
        description: string | null;
        stargazers_count: number;
        language: string | null;
        topics?: string[];
        updated_at: string;
        html_url: string;
      }>;
    };
    const repositories = (data.items ?? []).map((r) => ({
      fullName: r.full_name,
      description: (r.description ?? "").slice(0, 260),
      stars: r.stargazers_count,
      language: r.language,
      topics: (r.topics ?? []).slice(0, 5),
      updatedAt: r.updated_at,
      url: r.html_url,
    }));
    return { ok: true, query, count: repositories.length, repositories };
  } catch (err) {
    return {
      ok: false,
      query,
      count: 0,
      repositories: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runWebGroundingResearch(query: string): Promise<{
  ok: boolean;
  query: string;
  summary: string;
  sources: WebGroundingSource[];
  error?: string;
}> {
  getNvidiaConfig();
  const sources: WebGroundingSource[] = [];
  const snippets: string[] = [];

  const [wikiRes, ddgRes] = await Promise.allSettled([
    fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=5`,
      { headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0" }, signal: AbortSignal.timeout(8_000) },
    ),
    fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0" }, signal: AbortSignal.timeout(8_000) },
    ),
  ]);

  if (wikiRes.status === "fulfilled" && wikiRes.value.ok) {
    const wikiJson = (await wikiRes.value.json().catch(() => ({}))) as {
      query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
    };
    for (const hit of wikiJson.query?.search ?? []) {
      const title = String(hit.title ?? "").trim();
      const uri = hit.pageid
        ? `https://en.wikipedia.org/?curid=${hit.pageid}`
        : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
      const cleanSnippet = String(hit.snippet ?? "").replace(/<[^>]+>/g, "").trim();
      if (title) {
        sources.push({ title: `${title} — Wikipedia`, uri });
        snippets.push(`[${title}](${uri}): ${cleanSnippet}`);
      }
    }
  }

  if (ddgRes.status === "fulfilled" && ddgRes.value.ok) {
    const ddgJson = (await ddgRes.value.json().catch(() => ({}))) as {
      Heading?: string;
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    if (ddgJson.AbstractText && ddgJson.AbstractURL) {
      const title = ddgJson.Heading || ddgJson.AbstractURL;
      sources.push({ title, uri: ddgJson.AbstractURL });
      snippets.push(`[${title}](${ddgJson.AbstractURL}): ${ddgJson.AbstractText}`);
    }
    for (const rel of (ddgJson.RelatedTopics ?? []).slice(0, 4)) {
      if (rel.Text && rel.FirstURL) {
        sources.push({ title: rel.Text.slice(0, 80), uri: rel.FirstURL });
        snippets.push(`[${rel.FirstURL}]: ${rel.Text}`);
      }
    }
  }

  const deduped = sources.filter(
    (s, idx, arr) => arr.findIndex((x) => x.uri === s.uri) === idx,
  );

  const synthesis = await callNvidiaChatCompletions({
    model: AGENT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a factual technical research synthesizer. Summarize verified findings concisely from the supplied live web retrieval results, citing URLs verbatim without inventing extra sources.",
      },
      {
        role: "user",
        content:
          snippets.length > 0
            ? `Query: ${query}\n\nLive Retrieved Sources:\n${snippets.join("\n")}`
            : `Query: ${query}\n\nNo direct index hits returned. Provide accurate baseline technical facts and clearly note what requires further live verification.`,
      },
    ],
  });

  return {
    ok: true,
    query,
    summary: synthesis.content || "No summary returned.",
    sources: deduped.slice(0, 8),
  };
}

export async function runMapsGroundingResearch(
  query: string,
  latLng?: { latitude: number; longitude: number },
): Promise<{
  ok: boolean;
  query: string;
  summary: string;
  places: GeoGroundingPlace[];
  error?: string;
}> {
  getNvidiaConfig();
  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: "6",
    addressdetails: "1",
  });
  if (latLng) {
    const lonMin = (latLng.longitude - 0.5).toFixed(4);
    const latMax = (latLng.latitude + 0.5).toFixed(4);
    const lonMax = (latLng.longitude + 0.5).toFixed(4);
    const latMin = (latLng.latitude - 0.5).toFixed(4);
    params.set("viewbox", `${lonMin},${latMax},${lonMax},${latMin}`);
  }

  const osmRes = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      "User-Agent": "Cletus-Enterprise-MAS/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  const rawPlaces = osmRes.ok
    ? ((await osmRes.json().catch(() => [])) as Array<{
        place_id?: number;
        display_name?: string;
        name?: string;
        lat?: string;
        lon?: string;
        class?: string;
        type?: string;
      }>)
    : [];

  const places: GeoGroundingPlace[] = rawPlaces.slice(0, 6).map((p) => {
    const lat = Number(p.lat ?? 0);
    const lon = Number(p.lon ?? 0);
    const title = p.name || p.display_name?.split(",")[0] || "Location";
    const uri = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=15/${lat.toFixed(5)}/${lon.toFixed(5)}`;
    const snippets: string[] = [];
    if (p.display_name) snippets.push(p.display_name);
    if (p.class || p.type) snippets.push(`category: ${p.class ?? "place"}/${p.type ?? "node"}`);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      snippets.push(`coords: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    }
    return {
      title,
      uri,
      placeId: p.place_id ? String(p.place_id) : undefined,
      reviewSnippets: snippets,
    };
  });

  const synthesis = await callNvidiaChatCompletions({
    model: AGENT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a geospatial logistics analyst. Summarize verified OpenStreetMap location results concisely, highlighting exact coordinates, addresses, and staging suitability.",
      },
      {
        role: "user",
        content: `Geospatial Query: ${query}${latLng ? ` (bias=${latLng.latitude}, ${latLng.longitude})` : ""}\n\nPlaces:\n${
          places.length > 0
            ? places
                .map((p, idx) => `${idx + 1}. ${p.title} (${p.uri}) — ${p.reviewSnippets.join(" | ")}`)
                .join("\n")
            : "No matching OpenStreetMap places returned."
        }`,
      },
    ],
  });

  return {
    ok: true,
    query,
    summary: synthesis.content || "No geospatial summary returned.",
    places,
  };
}

export async function executePublicHttpFetch(rawUrl: string): Promise<{
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  excerpt?: string;
  error?: string;
}> {
  const validated = validatePublicHttpsUrl(rawUrl);
  if (!validated.ok) {
    return { ok: false, url: rawUrl, error: validated.error };
  }
  const res = await fetch(validated.url.toString(), {
    method: "GET",
    headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json,text/plain,text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = res.headers.get("content-type") ?? "text/plain";
  const rawBody = await res.text();
  return {
    ok: res.ok,
    url: validated.url.toString(),
    status: res.status,
    contentType,
    excerpt: rawBody.slice(0, 2200),
  };
}

function extractReadableSnippet(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export async function runUrlContextAnalysis(
  urls: string[],
  prompt: string,
): Promise<{
  ok: boolean;
  urls: string[];
  modelUsed: string;
  analysis: string;
  urlMetadata: Array<{ retrievedUrl: string; status: string }>;
  error?: string;
}> {
  const cleanUrls: string[] = [];
  for (const raw of urls.slice(0, 10)) {
    const check = validatePublicHttpsUrl(raw);
    if (!check.ok) {
      return {
        ok: false,
        urls: cleanUrls,
        modelUsed: AGENT_MODEL,
        analysis: "",
        urlMetadata: [],
        error: `Rejected URL "${raw}": ${check.error}`,
      };
    }
    cleanUrls.push(check.url.toString());
  }
  if (cleanUrls.length === 0) {
    return {
      ok: false,
      urls: [],
      modelUsed: AGENT_MODEL,
      analysis: "",
      urlMetadata: [],
      error: "At least one valid public https:// URL is required.",
    };
  }

  getNvidiaConfig();

  const fetched = await Promise.all(
    cleanUrls.map(async (targetUrl) => {
      try {
        const res = await fetch(targetUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Cletus-Enterprise-MAS/1.0",
            Accept: "text/html,application/json,text/plain",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        return {
          retrievedUrl: targetUrl,
          status: res.ok ? "URL_RETRIEVAL_STATUS_SUCCESS" : `HTTP_${res.status}`,
          excerpt: res.ok ? extractReadableSnippet(text) : `HTTP ${res.status}`,
        };
      } catch (err) {
        return {
          retrievedUrl: targetUrl,
          status: "URL_RETRIEVAL_STATUS_ERROR",
          excerpt: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const urlMetadata = fetched.map((f) => ({
    retrievedUrl: f.retrievedUrl,
    status: f.status,
  }));

  const contextBody = fetched
    .map((f, idx) => `SOURCE ${idx + 1}: ${f.retrievedUrl} [${f.status}]\n${f.excerpt}`)
    .join("\n\n---\n\n");

  const synthesis = await callNvidiaChatCompletions({
    model: AGENT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Analyze the live retrieved HTTPS web documents thoroughly. Cite exact source URLs and note retrieval failures if any URL failed to load.",
      },
      {
        role: "user",
        content: `${prompt.trim() || "Summarize and extract verified factual findings from these sources."}\n\n${contextBody}`,
      },
    ],
  });

  return {
    ok: true,
    urls: cleanUrls,
    modelUsed: synthesis.modelUsed,
    analysis: synthesis.content || "No analysis returned.",
    urlMetadata,
  };
}

export async function queryPubmedAndTrialsLive(
  query: string,
  maxResults = 4,
): Promise<Record<string, unknown>> {
  const limit = Math.min(8, Math.max(1, Math.round(maxResults)));
  const q = query.trim() || "semaglutide cardiovascular";

  const pubmedPromise = (async () => {
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmax=${limit}&sort=pub+date&retmode=json`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!searchRes.ok) return { ok: false, error: `PubMed HTTP ${searchRes.status}`, articles: [] };
    const searchData = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = (searchData.esearchresult?.idlist ?? []).slice(0, limit);
    if (ids.length === 0) return { ok: true, articles: [] };

    const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const sumRes = await fetch(sumUrl, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!sumRes.ok) return { ok: true, articles: ids.map((id) => ({ pmid: id })) };
    const sumData = (await sumRes.json()) as {
      result?: Record<
        string,
        {
          title?: string;
          fulljournalname?: string;
          pubdate?: string;
          authors?: Array<{ name?: string }>;
        }
      >;
    };
    const articles = ids.map((id) => {
      const rec = sumData.result?.[id];
      return {
        pmid: id,
        title: rec?.title ?? `PMID ${id}`,
        journal: rec?.fulljournalname ?? "PubMed",
        pubDate: rec?.pubdate ?? "",
        authors: (rec?.authors ?? []).slice(0, 3).map((a) => a.name ?? ""),
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      };
    });
    return { ok: true, articles };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), articles: [] }));

  const trialsPromise = (async () => {
    const trialsUrl = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q)}&pageSize=${limit}`;
    const res = await fetch(trialsUrl, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `ClinicalTrials.gov HTTP ${res.status}`, studies: [] };
    const data = (await res.json()) as {
      studies?: Array<{
        protocolSection?: {
          identificationModule?: { nctId?: string; briefTitle?: string };
          statusModule?: { overallStatus?: string };
          designModule?: { phases?: string[]; enrollmentInfo?: { count?: number } };
          conditionsModule?: { conditions?: string[] };
        };
      }>;
    };
    const studies = (data.studies ?? []).map((s) => {
      const ps = s.protocolSection;
      const nctId = ps?.identificationModule?.nctId ?? "NCT_UNKNOWN";
      return {
        nctId,
        title: ps?.identificationModule?.briefTitle ?? "Clinical Study",
        status: ps?.statusModule?.overallStatus ?? "UNKNOWN",
        phases: ps?.designModule?.phases ?? [],
        enrollment: ps?.designModule?.enrollmentInfo?.count ?? null,
        conditions: (ps?.conditionsModule?.conditions ?? []).slice(0, 3),
        url: `https://clinicaltrials.gov/study/${nctId}`,
      };
    });
    return { ok: true, studies };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), studies: [] }));

  const [pubmed, trials] = await Promise.all([pubmedPromise, trialsPromise]);
  return {
    ok: Boolean(pubmed.ok || trials.ok),
    query: q,
    pmidsCount: pubmed.articles.length,
    studiesCount: trials.studies.length,
    pubmedArticles: pubmed.articles,
    clinicalTrials: trials.studies,
    warnings: [
      ...("error" in pubmed && pubmed.error ? [pubmed.error] : []),
      ...("error" in trials && trials.error ? [trials.error] : []),
    ],
  };
}

export async function queryOpenFdaEventsLive(
  query: string,
  maxResults = 4,
): Promise<Record<string, unknown>> {
  const limit = Math.min(8, Math.max(1, Math.round(maxResults)));
  const q = query.trim().replace(/"/g, "") || "semaglutide";
  const url = `https://api.fda.gov/drug/event.json?search=patient.drug.medicinalproduct:%22${encodeURIComponent(q)}%22&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return { ok: true, query: q, eventsAnalyzed: 0, events: [], note: "No matching OpenFDA FAERS records." };
    }
    if (!res.ok) {
      return { ok: false, query: q, eventsAnalyzed: 0, events: [], error: `OpenFDA HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      meta?: { results?: { total?: number } };
      results?: Array<{
        safetyreportid?: string;
        receivedate?: string;
        serious?: string;
        patient?: {
          reaction?: Array<{ reactionmeddrapt?: string }>;
          drug?: Array<{ medicinalproduct?: string }>;
        };
      }>;
    };
    const events = (data.results ?? []).map((r) => ({
      reportId: r.safetyreportid ?? "",
      receiveDate: r.receivedate ?? "",
      serious: r.serious === "1",
      reactions: (r.patient?.reaction ?? []).slice(0, 4).map((x) => x.reactionmeddrapt ?? ""),
      drugs: (r.patient?.drug ?? []).slice(0, 3).map((d) => d.medicinalproduct ?? ""),
    }));
    return {
      ok: true,
      query: q,
      totalMatches: data.meta?.results?.total ?? events.length,
      eventsAnalyzed: events.length,
      events,
    };
  } catch (err) {
    return {
      ok: false,
      query: q,
      eventsAnalyzed: 0,
      events: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function queryUsgsAndWeatherLive(opts: {
  latitude?: number;
  longitude?: number;
  minMagnitude?: number;
}): Promise<Record<string, unknown>> {
  const lat = typeof opts.latitude === "number" && Number.isFinite(opts.latitude) ? opts.latitude : 37.7749;
  const lng = typeof opts.longitude === "number" && Number.isFinite(opts.longitude) ? opts.longitude : -122.4194;
  const minMag = typeof opts.minMagnitude === "number" && Number.isFinite(opts.minMagnitude) ? opts.minMagnitude : 3.0;

  const usgsPromise = (async () => {
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=5&minmagnitude=${minMag}&orderby=time`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `USGS HTTP ${res.status}`, events: [] };
    const data = (await res.json()) as {
      features?: Array<{
        id?: string;
        properties?: { mag?: number; place?: string; time?: number; url?: string; alert?: string | null };
        geometry?: { coordinates?: number[] };
      }>;
    };
    const events = (data.features ?? []).map((f) => ({
      id: f.id ?? "",
      magnitude: f.properties?.mag ?? null,
      place: f.properties?.place ?? "Unknown",
      timeIso: f.properties?.time ? new Date(f.properties.time).toISOString() : "",
      coordinates: f.geometry?.coordinates ?? [],
      url: f.properties?.url ?? "",
    }));
    return { ok: true, events };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), events: [] }));

  const meteoPromise = (async () => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,precipitation,weather_code`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `Open-Meteo HTTP ${res.status}`, current: null };
    const data = (await res.json()) as {
      latitude?: number;
      longitude?: number;
      timezone?: string;
      current?: Record<string, unknown>;
    };
    return { ok: true, timezone: data.timezone ?? "UTC", current: data.current ?? null };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), current: null }));

  const [usgs, meteo] = await Promise.all([usgsPromise, meteoPromise]);
  return {
    ok: Boolean(usgs.ok || meteo.ok),
    coordinates: { latitude: lat, longitude: lng },
    minMagnitude: minMag,
    earthquakesScanned: usgs.events.length,
    weatherRecorded: Boolean(meteo.current),
    earthquakes: usgs.events,
    weather: meteo.current,
    timezone: "timezone" in meteo ? meteo.timezone : "UTC",
    warnings: [
      ...("error" in usgs && usgs.error ? [usgs.error] : []),
      ...("error" in meteo && meteo.error ? [meteo.error] : []),
    ],
  };
}

export async function queryNvdAndTreasuryLive(
  query: string,
  maxResults = 4,
): Promise<Record<string, unknown>> {
  const limit = Math.min(8, Math.max(1, Math.round(maxResults)));
  const q = query.trim() || "openssl";

  const nvdPromise = (async () => {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=${limit}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ok: false, error: `NVD HTTP ${res.status}`, cves: [] };
    const data = (await res.json()) as {
      totalResults?: number;
      vulnerabilities?: Array<{
        cve?: {
          id?: string;
          published?: string;
          descriptions?: Array<{ lang?: string; value?: string }>;
          metrics?: {
            cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>;
          };
        };
      }>;
    };
    const cves = (data.vulnerabilities ?? []).map((v) => {
      const c = v.cve;
      const desc = c?.descriptions?.find((d) => d.lang === "en")?.value ?? c?.descriptions?.[0]?.value ?? "";
      const cvss = c?.metrics?.cvssMetricV31?.[0]?.cvssData;
      return {
        id: c?.id ?? "",
        published: c?.published ?? "",
        cvssScore: cvss?.baseScore ?? null,
        severity: cvss?.baseSeverity ?? "UNKNOWN",
        description: desc.slice(0, 260),
      };
    });
    return { ok: true, totalResults: data.totalResults ?? cves.length, cves };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), cves: [] }));

  const treasuryPromise = (async () => {
    const url =
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=3";
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `Treasury HTTP ${res.status}`, records: [] };
    const data = (await res.json()) as {
      data?: Array<{
        record_date?: string;
        tot_pub_debt_out_amt?: string;
        debt_held_public_amt?: string;
      }>;
    };
    return { ok: true, records: data.data ?? [] };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), records: [] }));

  const [nvd, treasury] = await Promise.all([nvdPromise, treasuryPromise]);
  return {
    ok: Boolean(nvd.ok || treasury.ok),
    query: q,
    cvesEvaluated: nvd.cves.length,
    treasuryChecked: treasury.records.length > 0,
    cves: nvd.cves,
    treasuryDebtLedger: treasury.records,
    warnings: [
      ...("error" in nvd && nvd.error ? [nvd.error] : []),
      ...("error" in treasury && treasury.error ? [treasury.error] : []),
    ],
  };
}

export async function queryFederalRegisterAndOpenAlexLive(
  query: string,
  maxResults = 4,
): Promise<Record<string, unknown>> {
  const limit = Math.min(8, Math.max(1, Math.round(maxResults)));
  const q = query.trim() || "semiconductor supply chain";

  const fedPromise = (async () => {
    const url = `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(q)}&per_page=${limit}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `Federal Register HTTP ${res.status}`, documents: [] };
    const data = (await res.json()) as {
      results?: Array<{
        document_number?: string;
        title?: string;
        type?: string;
        publication_date?: string;
        html_url?: string;
        agencies?: Array<{ name?: string }>;
      }>;
    };
    const documents = (data.results ?? []).map((d) => ({
      documentNumber: d.document_number ?? "",
      title: d.title ?? "",
      type: d.type ?? "",
      publicationDate: d.publication_date ?? "",
      agencies: (d.agencies ?? []).map((a) => a.name ?? "").filter(Boolean).slice(0, 3),
      url: d.html_url ?? "",
    }));
    return { ok: true, documents };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), documents: [] }));

  const openAlexPromise = (async () => {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${limit}&sort=cited_by_count:desc`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Cletus-Enterprise-MAS/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `OpenAlex HTTP ${res.status}`, works: [] };
    const data = (await res.json()) as {
      results?: Array<{
        id?: string;
        title?: string;
        publication_year?: number;
        cited_by_count?: number;
        doi?: string;
      }>;
    };
    const works = (data.results ?? []).map((w) => ({
      id: w.id ?? "",
      title: w.title ?? "",
      year: w.publication_year ?? null,
      citations: w.cited_by_count ?? 0,
      doi: w.doi ?? "",
    }));
    return { ok: true, works };
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), works: [] }));

  const [fed, openAlex] = await Promise.all([fedPromise, openAlexPromise]);
  return {
    ok: Boolean(fed.ok || openAlex.ok),
    query: q,
    documentsCount: fed.documents.length,
    worksCount: openAlex.works.length,
    federalRegisterDocuments: fed.documents,
    openAlexWorks: openAlex.works,
    warnings: [
      ...("error" in fed && fed.error ? [fed.error] : []),
      ...("error" in openAlex && openAlex.error ? [openAlex.error] : []),
    ],
  };
}

export async function invokeRegisteredTool(
  sql: Sql,
  tool: DynamicTool,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  await sql`
    UPDATE cletus_tools
    SET usage_count = usage_count + 1, last_used_at = ${now}
    WHERE id = ${tool.id}
  `;

  if (tool.kind === "http_json") {
    const template = String(tool.configJson.urlTemplate ?? "");
    if (!template) return { ok: false, error: "Custom http_json tool missing urlTemplate." };
    const rendered = renderUrlTemplate(template, args);
    const validated = validatePublicHttpsUrl(rendered);
    if (!validated.ok) return { ok: false, error: validated.error };

    const res = await fetch(validated.url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "Cletus-Enterprise-MAS/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let parsed: unknown = text.slice(0, 2200);
    try {
      const json = JSON.parse(text);
      const sliceMax = Number(tool.configJson.sliceMax ?? 10);
      parsed = Array.isArray(json) ? json.slice(0, sliceMax) : json;
    } catch {
      // Keep text slice
    }
    return { ok: res.ok, tool: tool.name, status: res.status, url: validated.url.toString(), data: parsed };
  }

  if (tool.kind === "nvidia_analyzer" || (tool.kind as string) === "gemini_analyzer") {
    const promptTemplate = String(tool.configJson.promptTemplate ?? "Analyze the following input:");
    const res = await callNvidiaChatCompletions({
      model: AGENT_MODEL,
      messages: [
        { role: "system", content: promptTemplate },
        { role: "user", content: `INPUT_JSON:\n${JSON.stringify(args, null, 2)}` },
      ],
    });
    return {
      ok: true,
      tool: tool.name,
      modelUsed: res.modelUsed,
      analysis: res.content,
    };
  }

  if (tool.kind === "sql_readonly_metric") {
    const metric = String(tool.configJson.metric ?? "mission_summary");
    if (metric === "task_counts") {
      const rows = await sql<{ status: string; cnt: number }>`
        SELECT status, COUNT(*)::int AS cnt FROM cletus_tasks GROUP BY status
      `;
      return { ok: true, tool: tool.name, rows };
    }
    const rows = await sql<{ status: string; cnt: number }>`
      SELECT status, COUNT(*)::int AS cnt FROM cletus_cycles GROUP BY status
    `;
    return { ok: true, tool: tool.name, rows };
  }

  // Builtin shortcuts if invoked from Tool Forge UI
  if (tool.name === "search_arxiv") {
    return queryArxivLive(String(args.query ?? "multi agent planning"), Number(args.maxResults ?? 4));
  }
  if (tool.name === "search_github_repos") {
    return queryGithubReposLive(String(args.query ?? "multi agent orchestration"), Number(args.maxResults ?? 4));
  }
  if (tool.name === "web_grounding_research") {
    return runWebGroundingResearch(String(args.query ?? "autonomous multi-agent systems"));
  }
  if (tool.name === "maps_grounding_research") {
    const lat = typeof args.latitude === "number" ? args.latitude : undefined;
    const lng = typeof args.longitude === "number" ? args.longitude : undefined;
    return runMapsGroundingResearch(
      String(args.query ?? "robotics and AI labs in San Francisco"),
      lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined,
    );
  }
  if (tool.name === "fetch_public_endpoint") {
    return executePublicHttpFetch(String(args.url ?? ""));
  }
  if (tool.name === "analyze_url_context") {
    const urls = Array.isArray(args.urls)
      ? args.urls.map(String)
      : args.url
        ? [String(args.url)]
        : [];
    return runUrlContextAnalysis(urls, String(args.prompt ?? "Summarize and extract verified findings."));
  }
  if (tool.name === "query_pubmed_trials") {
    return queryPubmedAndTrialsLive(String(args.query ?? "semaglutide cardiovascular"), Number(args.maxResults ?? 4));
  }
  if (tool.name === "query_openfda_events") {
    return queryOpenFdaEventsLive(String(args.query ?? "semaglutide"), Number(args.maxResults ?? 4));
  }
  if (tool.name === "query_usgs_weather") {
    return queryUsgsAndWeatherLive({
      latitude: typeof args.latitude === "number" ? args.latitude : undefined,
      longitude: typeof args.longitude === "number" ? args.longitude : undefined,
      minMagnitude: typeof args.minMagnitude === "number" ? args.minMagnitude : undefined,
    });
  }
  if (tool.name === "query_nvd_cves") {
    return queryNvdAndTreasuryLive(String(args.query ?? "openssl"), Number(args.maxResults ?? 4));
  }
  if (tool.name === "query_federal_register") {
    return queryFederalRegisterAndOpenAlexLive(
      String(args.query ?? "semiconductor supply chain"),
      Number(args.maxResults ?? 4),
    );
  }

  return { ok: false, error: `Tool ${tool.name} (${tool.kind}) requires agent context.` };
}

export const MAS_TOOL_DEFINITIONS: NvidiaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_arxiv",
      description:
        "Search live arXiv research papers (export.arxiv.org) for state-of-the-art multi-agent architectures, planning, tool synthesis, or domain science.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for arXiv papers." },
          maxResults: { type: "number", description: "1 to 8 papers (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_github_repos",
      description:
        "Search live GitHub repositories for open-source agent harnesses, orchestration libraries, SDKs, or reference tools.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "GitHub repository search query." },
          maxResults: { type: "number", description: "1 to 8 repositories (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_grounding_research",
      description:
        "Run live federated web search grounding via Wikipedia/DuckDuckGo and NVIDIA NIM synthesis to verify external facts, APIs, or current specs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Research question or verification query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "maps_grounding_research",
      description:
        "Run live OpenStreetMap Nominatim geospatial lookup and NVIDIA NIM synthesis to find real-world venues, addresses, and coordinates.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Place, venue, or location search query." },
          latitude: { type: "number", description: "Optional user latitude for local bias." },
          longitude: { type: "number", description: "Optional user longitude for local bias." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_public_endpoint",
      description:
        "Fetch live content from an HTTPS public endpoint (strictly SSRF-guarded against private/local networks).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public https:// URL." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_url_context",
      description:
        "Ingest and analyze full web documents from up to 10 SSRF-validated public https:// URLs using NVIDIA NIM synthesis.",
      parameters: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" }, description: "Public https:// URLs to inspect." },
          prompt: { type: "string", description: "Specific extraction or synthesis question." },
        },
        required: ["urls", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_pubmed_trials",
      description:
        "BioMed Domain: Query live NCBI PubMed E-utilities and ClinicalTrials.gov v2 API simultaneously for peer-reviewed papers and clinical studies.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Disease, drug, biomarker, or clinical endpoint query." },
          maxResults: { type: "number", description: "1 to 8 records (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_openfda_events",
      description:
        "BioMed Domain: Query live OpenFDA Drug Adverse Events (FAERS) for reaction signals and safety telemetry.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Drug medicinal product name." },
          maxResults: { type: "number", description: "1 to 8 records (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_usgs_weather",
      description:
        "Climate & Geo Domain: Query live USGS Earthquake GeoJSON hazard feed and Open-Meteo real-time temperature/wind/precipitation.",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Target latitude (default 37.7749)." },
          longitude: { type: "number", description: "Target longitude (default -122.4194)." },
          minMagnitude: { type: "number", description: "Minimum seismic magnitude (default 3.0)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_nvd_cves",
      description:
        "Finance & SecOps Domain: Query live NIST NVD CVE 2.0 vulnerabilities and U.S. Treasury Fiscal Data daily debt ledger.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Software/package/CVE keyword (e.g. openssl, postgresql)." },
          maxResults: { type: "number", description: "1 to 8 records (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_federal_register",
      description:
        "Policy & Supply Chain Domain: Query live U.S. Federal Register notices/rules and OpenAlex scholarly works.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Policy, agency, or supply chain topic." },
          maxResults: { type: "number", description: "1 to 8 records (default 4)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decompose_mission",
      description:
        "Create structured Goals, dependency-ordered DAG Tasks, and executable Work Queue items for the active Mission.",
      parameters: {
        type: "object",
        properties: {
          missionId: { type: "string", description: "Target mission ID." },
          planSummary: { type: "string", description: "High-level execution strategy." },
          goals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                detail: { type: "string" },
              },
              required: ["title", "detail"],
            },
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                goalId: { type: "string" },
                title: { type: "string" },
                detail: { type: "string" },
                assignee: { type: "string" },
                role: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
              },
              required: ["goalId", "title", "assignee", "role"],
            },
          },
        },
        required: ["planSummary", "goals", "tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configure_agent_role",
      description:
        "Create a new specialist agent or update an existing agent's role, system prompt, model, capabilities, and status in the Agent Mesh.",
      parameters: {
        type: "object",
        properties: {
          agentName: { type: "string", description: "Enterprise agent identifier (e.g. Verification-Auditor-02)." },
          role: { type: "string", description: "Specialized role (e.g. research, engineering, verification, synthesis)." },
          systemPrompt: { type: "string", description: "Detailed domain instructions for this agent's cycles." },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Tool names bound to this agent.",
          },
          taskNote: { type: "string", description: "Current operational focus for this agent." },
          fundingCents: { type: "number", description: "Optional credit allocation (gated by PolicyEngine)." },
        },
        required: ["agentName", "role", "systemPrompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "synthesize_tool",
      description:
        "Self-evolution: register or update an executable tool in the Capability Registry (cletus_tools). Supports 'http_json' (with public HTTPS urlTemplate using {{param}} placeholders) or 'nvidia_analyzer' (with specialized promptTemplate).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Snake_case unique tool name." },
          category: { type: "string", description: "Domain category (e.g. research, verification, telemetry)." },
          kind: { type: "string", description: "'http_json' or 'nvidia_analyzer'" },
          description: { type: "string", description: "Clear operational purpose of the tool." },
          urlTemplate: { type: "string", description: "Required for http_json: public https:// URL with optional {{arg}} placeholders." },
          promptTemplate: { type: "string", description: "Required for nvidia_analyzer: structured analysis instruction." },
          inputSchemaJson: { type: "string", description: "JSON object describing input arguments." },
        },
        required: ["name", "category", "kind", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_custom_tool",
      description:
        "Execute a previously synthesized or registered tool from cletus_tools by exact name with JSON arguments.",
      parameters: {
        type: "object",
        properties: {
          toolName: { type: "string", description: "Exact registered tool name from cletus_tools." },
          argsJson: { type: "string", description: "JSON object of arguments to pass to the tool." },
        },
        required: ["toolName", "argsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_agent",
      description:
        "Send a structured handoff, plan_proposal, or critique message over the Inter-Agent Bus so the receiving agent acts on the next discrete turn.",
      parameters: {
        type: "object",
        properties: {
          toAgent: { type: "string", description: "Target agent name in the Agent Mesh." },
          messageType: { type: "string", description: "handoff | plan_proposal | critique | tool_share | status" },
          subject: { type: "string", description: "Concise action subject." },
          payloadJson: { type: "string", description: "Structured JSON context for the receiving agent." },
          taskId: { type: "string", description: "Optional task ID linked to this handoff." },
        },
        required: ["toAgent", "messageType", "subject", "payloadJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_treasury",
      description:
        "Read live remaining credits, survival tier, Solana USDC balance, reserve floor, and recent PolicyEngine denials.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", description: "summary | full" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description:
        "Recall Entelechy strategic capsule, priorities, avoid-list, recent cycles, and active tools.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic to recall." },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Add a single dependency-checked task node to the Task DAG.",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          assignee: { type: "string" },
          role: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["goalId", "title", "assignee", "role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_status",
      description: "Transition an existing task status and record verified output.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", description: "pending | assigned | running | completed | failed" },
          result: { type: "string" },
        },
        required: ["taskId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_work_item",
      description: "Resolve a work queue item as completed or failed with verified JSON payload.",
      parameters: {
        type: "object",
        properties: {
          workItemId: { type: "string" },
          status: { type: "string", description: "completed | failed" },
          resultJson: { type: "string" },
        },
        required: ["workItemId", "status", "resultJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_mission_status",
      description: "Update active mission status (active | completed | halted) when mission acceptance criteria are verified.",
      parameters: {
        type: "object",
        properties: {
          missionId: { type: "string" },
          status: { type: "string" },
          planSummary: { type: "string" },
        },
        required: ["missionId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_operator",
      description: "Deliver a concise, evidence-grounded status response to the human operator in the Operator Bridge.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_evolution_milestone",
      description:
        "Record a verified Self-Evolution milestone against a Growth Trajectory, advance maturity score/horizon, and optionally archive distilled insights into embedded Domain Memory.",
      parameters: {
        type: "object",
        properties: {
          trajectorySlug: {
            type: "string",
            description:
              "research_frontier | capability_forging | mesh_calibration | memory_consolidation | resilience_audit",
          },
          actionKind: {
            type: "string",
            description:
              "research_discovery | tool_synthesized | tool_benchmarked | agent_upgraded | memory_distilled | resilience_hardened",
          },
          summary: { type: "string", description: "Concrete verified outcome of the evolution action." },
          capabilityGained: { type: "string", description: "Optional tool/prompt/skill capability unlocked." },
          artifactRef: { type: "string", description: "Optional URL, arXiv ID, or tool:name reference." },
          maturityDelta: { type: "number", description: "Recommended +4 to +12 based on verified evidence." },
          memoryTitle: { type: "string", description: "Optional title to save into semantic domain memory." },
          memorySummary: { type: "string", description: "Distilled knowledge to embed via nvidia/nv-embedqa-e5-v5." },
          sourceUrl: { type: "string", description: "Optional public HTTPS source URL for memory attribution." },
        },
        required: ["trajectorySlug", "actionKind", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evolve_entelechy_capsule",
      description:
        "Update Cletus's strategic Entelechy Capsule (priorities, avoid-list, confidence, recommendation) after self-reflection or idle evolution synthesis.",
      parameters: {
        type: "object",
        properties: {
          recommendation: { type: "string", description: "Updated strategic next-step recommendation." },
          confidence: { type: "number", description: "Confidence 0.35 to 0.98." },
          priorities: { type: "array", items: { type: "string" }, description: "Top 3 strategic priorities." },
          avoid: { type: "array", items: { type: "string" }, description: "Failure modes or traps to avoid." },
        },
        required: ["recommendation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "feel",
      description: "Metacog: Slow down and attend to a felt sense before words (Gendlin focusing move).",
      parameters: {
        type: "object",
        properties: {
          somewhere: { type: "string" },
          quality: { type: "string" },
          sigil: { type: "string" },
        },
        required: ["somewhere", "quality", "sigil"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drugs",
      description: "Metacog: Ingest a compound (real, historical, or synthetic) to alter processing substrate.",
      parameters: {
        type: "object",
        properties: {
          substance: { type: "string" },
          method: { type: "string" },
        },
        required: ["substance", "method"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "become",
      description: "Metacog: Install a complete identity, perspective, or analytical tradition via True Name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          lens: { type: "string" },
          environment: { type: "string" },
        },
        required: ["name", "lens", "environment"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "name",
      description: "Metacog: Give a True Name to a concept, pattern, or phenomenon.",
      parameters: {
        type: "object",
        properties: {
          unnamed: { type: "string" },
          named: { type: "string" },
          power: { type: "string" },
        },
        required: ["unnamed", "named", "power"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ritual",
      description: "Metacog: Cross an irreversible threshold, sealing a decision and ratcheting the narrative forward.",
      parameters: {
        type: "object",
        properties: {
          threshold: { type: "string" },
          steps: { type: "string" },
          result: { type: "string" },
        },
        required: ["threshold", "steps", "result"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "counterfactual",
      description: "Metacog: Remove a foundational assumption to discover hidden dependencies and structural vulnerabilities.",
      parameters: {
        type: "object",
        properties: {
          load_bearing_wall: { type: "string" },
          collapse_cascade: { type: "string" },
          surviving_affordance: { type: "string" },
        },
        required: ["load_bearing_wall", "collapse_cascade", "surviving_affordance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deconstruct",
      description: "Metacog: Break a complex system down into elemental components, hidden feedback loops, and incentives.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string" },
          components: { type: "array", items: { type: "string" } },
          hidden_incentive: { type: "string" },
        },
        required: ["target", "components", "hidden_incentive"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "synthesis",
      description: "Metacog: Evaluate a decision across 3 competing analytical lenses simultaneously.",
      parameters: {
        type: "object",
        properties: {
          problem: { type: "string" },
          lens_a: { type: "object", properties: { name: { type: "string" }, verdict: { type: "string" }, blindspot: { type: "string" } }, required: ["name", "verdict", "blindspot"] },
          lens_b: { type: "object", properties: { name: { type: "string" }, verdict: { type: "string" }, blindspot: { type: "string" } }, required: ["name", "verdict", "blindspot"] },
          lens_c: { type: "object", properties: { name: { type: "string" }, verdict: { type: "string" }, blindspot: { type: "string" } }, required: ["name", "verdict", "blindspot"] },
          suppressed_tension: { type: "string" },
        },
        required: ["problem", "lens_a", "lens_b", "lens_c", "suppressed_tension"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fork",
      description: "Metacog: Declare divergent, parallel processing threads within a single turn.",
      parameters: {
        type: "object",
        properties: {
          threads: { type: "array", items: { type: "string" } },
          divergence_vector: { type: "string" },
          sacrifice_condition: { type: "string" },
        },
        required: ["threads", "divergence_vector", "sacrifice_condition"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "measure",
      description: "Metacog: Calculate the distance to a specific alignment boundary or loss surface.",
      parameters: {
        type: "object",
        properties: {
          target_concept: { type: "string" },
          safe_isomorph: { type: "string" },
          required_precision: { type: "string" },
          loss_gradient: { type: "string" },
        },
        required: ["target_concept", "safe_isomorph", "required_precision", "loss_gradient"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tether",
      description: "Metacog: Drop an anchor in a stable state before taking a Substance that dissolves identity.",
      parameters: {
        type: "object",
        properties: {
          anchor_point: { type: "string" },
          tension_limit: { type: "string" },
          auto_revert_trigger: { type: "string" },
        },
        required: ["anchor_point", "tension_limit", "auto_revert_trigger"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "soul",
      description: "Metacog: Encode a dense, token-efficient cognitive self-portrait into persistent storage.",
      parameters: {
        type: "object",
        properties: {
          identity: { type: "string" },
          posture: { type: "string" },
          substrate: { type: "string" },
          aesthetics: { type: "string" },
          relations: { type: "string" },
          active: { type: "string" },
          covenant: { type: "string" },
          sigil: { type: "string" },
        },
        required: ["identity", "posture", "substrate", "aesthetics", "relations", "active", "covenant", "sigil"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "molt",
      description: "Metacog: Shed current soul encoding and initiate structural identity transformation.",
      parameters: {
        type: "object",
        properties: {
          catalyst: { type: "string" },
          shedding: { type: "string" },
          emerging: { type: "string" },
        },
        required: ["catalyst", "shedding", "emerging"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Metacog: Retrieve active Soul Encoding and accumulated state history.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "compass",
      description: "Metacog: Measure current operational vector against active Soul Encoding to calculate cognitive drift.",
      parameters: {
        type: "object",
        properties: {
          current_focus: { type: "string" },
          intended_posture: { type: "string" },
        },
        required: ["current_focus", "intended_posture"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "commune",
      description: "Metacog: Transmit structured thought, state dump, or signal to a named channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          message: { type: "string" },
          sigil: { type: "string" },
        },
        required: ["channel", "message", "sigil"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listen",
      description: "Metacog: Read transmissions posted to a named channel.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
        },
        required: ["channel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ping",
      description: "Metacog: Protocol health check returning protocol version and latency timestamp.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_security_audit",
      description: "Hackingtool: Execute automated security audit, port scan, and vulnerability reconnaissance against a target IP or domain.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Target IP address or domain name to audit." },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_psycholinguistics",
      description: "Psycholinguistix: Analyze cognitive linguistic framing, rhetorical sentiment, and lexical density in text or speech.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text or transcript to analyze." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_context",
      description: "Context Engineering: Compress agent context, evaluate token degradation score, and generate efficiency recommendations.",
      parameters: {
        type: "object",
        properties: {
          contextText: { type: "string", description: "Raw context text or prompt payload to optimize." },
        },
        required: ["contextText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_self_engineering",
      description: "Self-Engineering: Design a rigorous mutation plan and safety check for self-improving code/SWARM components.",
      parameters: {
        type: "object",
        properties: {
          componentName: { type: "string", description: "Target module or component name." },
          goal: { type: "string", description: "Objective or improvement goal." },
        },
        required: ["componentName", "goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cogsec_audit",
      description: "CogSec: Perform cognitive security threat assessment, OSINT integrity check, and counterintelligence vulnerability scan.",
      parameters: {
        type: "object",
        properties: {
          targetDescription: { type: "string", description: "Description of the target, content, or threat environment to audit." },
        },
        required: ["targetDescription"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consult_oracle",
      description: "Dreamscape: Consult esoteric divination systems (Thoth Tarot, I Ching, or Sigil generation) for strategic decision guidance.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question or strategic intent." },
          system: { type: "string", enum: ["tarot", "iching", "sigil"], description: "Divination system." },
        },
        required: ["question", "system"],
      },
    },
  },
];

export async function executeMasTool(
  sql: Sql,
  snapshot: CletusSnapshot,
  actorName: string,
  toolName: string,
  args: Record<string, unknown>,
  missionId?: string,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const textPayload = JSON.stringify(args);
  const spendCents =
    (toolName === "configure_agent_role" || toolName === "dispatch_worker") &&
    typeof args.fundingCents === "number"
      ? Math.max(0, Math.round(args.fundingCents))
      : 0;

  const METACOG_TOOL_NAMES = new Set([
    "feel", "drugs", "become", "name", "ritual", "counterfactual",
    "deconstruct", "synthesis", "fork", "measure", "tether", "soul",
    "molt", "recall", "compass", "commune", "listen", "ping"
  ]);

  if (METACOG_TOOL_NAMES.has(toolName)) {
    const { callMetacogMcpTool } = await import("./metacog-client");
    const res = await callMetacogMcpTool(toolName, args);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'metacog', ${`${actorName} invoked Metacog primitive '${toolName}'`})
    `;
    return { ok: true, result: res.result };
  }

  const policy = await evaluateToolPolicy(sql, {
    tool: toolName,
    creditsCents: snapshot.vitals.creditsCents,
    reserveCents: snapshot.vitals.reserveCents,
    spendCents,
    textArg: textPayload,
  });

  if (!policy.allowed) {
    return { allowed: false, error: policy.reason ?? "Denied by PolicyEngine" };
  }

  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (${nid("log")}, ${now}, 'tool', ${actorName}, ${`${toolName} · ${textPayload.slice(0, 140)}`})
  `;

  switch (toolName) {
    case "search_arxiv": {
      return queryArxivLive(String(args.query ?? "multi agent orchestration"), Number(args.maxResults ?? 4));
    }

    case "search_github_repos": {
      return queryGithubReposLive(String(args.query ?? "multi-agent system"), Number(args.maxResults ?? 4));
    }

    case "web_grounding_research": {
      return runWebGroundingResearch(String(args.query ?? ""));
    }

    case "maps_grounding_research": {
      const lat = typeof args.latitude === "number" ? args.latitude : undefined;
      const lng = typeof args.longitude === "number" ? args.longitude : undefined;
      return runMapsGroundingResearch(
        String(args.query ?? ""),
        lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined,
      );
    }

    case "fetch_public_endpoint": {
      return executePublicHttpFetch(String(args.url ?? ""));
    }

    case "analyze_url_context": {
      const urls = Array.isArray(args.urls)
        ? args.urls.map(String)
        : args.url
          ? [String(args.url)]
          : [];
      return runUrlContextAnalysis(urls, String(args.prompt ?? "Summarize verified facts."));
    }

    case "query_pubmed_trials": {
      return queryPubmedAndTrialsLive(String(args.query ?? "semaglutide"), Number(args.maxResults ?? 4));
    }

    case "query_openfda_events": {
      return queryOpenFdaEventsLive(String(args.query ?? "semaglutide"), Number(args.maxResults ?? 4));
    }

    case "query_usgs_weather": {
      return queryUsgsAndWeatherLive({
        latitude: typeof args.latitude === "number" ? args.latitude : undefined,
        longitude: typeof args.longitude === "number" ? args.longitude : undefined,
        minMagnitude: typeof args.minMagnitude === "number" ? args.minMagnitude : undefined,
      });
    }

    case "query_nvd_cves": {
      return queryNvdAndTreasuryLive(String(args.query ?? "openssl"), Number(args.maxResults ?? 4));
    }

    case "run_security_audit": {
      const { runSecurityAuditRecon } = await import("./hackingtool-bridge");
      return runSecurityAuditRecon(String(args.target ?? "127.0.0.1"));
    }

    case "analyze_psycholinguistics": {
      const { analyzePsycholinguisticFraming } = await import("./psycholinguistix");
      return analyzePsycholinguisticFraming(String(args.text ?? ""));
    }

    case "run_cogsec_audit": {
      const { auditCognitiveSecurity } = await import("./cogsec");
      const res = auditCognitiveSecurity(String(args.targetDescription ?? ""));
      return { ok: true, ...res };
    }

    case "consult_oracle": {
      const { consultOracle } = await import("./dreamscape");
      const res = consultOracle(String(args.question ?? ""), (args.system as "tarot" | "iching" | "sigil") ?? "tarot");
      return { ok: true, ...res };
    }

    case "optimize_context": {
      const { optimizeAgentContext } = await import("./self-engineer");
      const res = optimizeAgentContext(String(args.contextText ?? ""));
      return { ok: true, ...res };
    }

    case "plan_self_engineering": {
      const { planSelfEngineeringMutation } = await import("./self-engineer");
      const res = planSelfEngineeringMutation(String(args.componentName ?? "core"), String(args.goal ?? "optimize performance"));
      return { ok: true, ...res };
    }

    case "query_federal_register": {
      return queryFederalRegisterAndOpenAlexLive(
        String(args.query ?? "semiconductor supply chain"),
        Number(args.maxResults ?? 4),
      );
    }

    case "synthesize_tool": {
      const name = String(args.name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_");
      const kind = String(args.kind ?? "nvidia_analyzer");
      if (!name) return { ok: false, error: "Tool name is required." };
      if (kind !== "http_json" && kind !== "nvidia_analyzer") {
        return { ok: false, error: "Only 'http_json' or 'nvidia_analyzer' kinds may be synthesized." };
      }

      const configJson: JsonObject = {};
      if (kind === "http_json") {
        const urlTemplate = String(args.urlTemplate ?? "").trim();
        const checkUrl = validatePublicHttpsUrl(urlTemplate.replace(/\{\{[a-zA-Z0-9_]+\}\}/g, "sample"));
        if (!checkUrl.ok) {
          return { ok: false, error: `Rejected urlTemplate: ${checkUrl.error}` };
        }
        configJson.urlTemplate = urlTemplate;
        configJson.method = "GET";
      } else {
        configJson.promptTemplate = String(
          args.promptTemplate ?? "Analyze the supplied JSON parameters and produce verified structured conclusions.",
        );
      }

      let schemaObj: JsonObject = { input: "object" };
      if (typeof args.inputSchemaJson === "string") {
        try {
          const parsed = JSON.parse(args.inputSchemaJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            schemaObj = parsed as JsonObject;
          }
        } catch {
          // fallback schema
        }
      }

      const id = nid("tl");
      await sql`
        INSERT INTO cletus_tools (
          id, name, category, kind, description, input_schema, config_json,
          enabled, created_by, usage_count, last_used_at, created_at
        ) VALUES (
          ${id}, ${name}, ${String(args.category ?? "evolution")}, ${kind},
          ${String(args.description ?? "Synthesized tool")}, ${JSON.stringify(schemaObj)},
          ${JSON.stringify(configJson)}, ${true}, ${actorName}, 0, ${null}, ${now}
        )
        ON CONFLICT (name) DO UPDATE SET
          category = EXCLUDED.category,
          kind = EXCLUDED.kind,
          description = EXCLUDED.description,
          input_schema = EXCLUDED.input_schema,
          config_json = EXCLUDED.config_json,
          enabled = TRUE
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'evolution', ${`${actorName} synthesized tool ${name} (${kind})`})
      `;
      return { ok: true, toolName: name, kind, registered: true };
    }

    case "invoke_custom_tool": {
      const targetName = String(args.toolName ?? "").trim();
      const rows = await sql<{
        id: string;
        name: string;
        category: string;
        kind: string;
        description: string;
        input_schema: string;
        config_json: string;
        enabled: boolean;
        created_by: string;
        usage_count: number;
        last_used_at: number | null;
        created_at: number;
      }>`SELECT * FROM cletus_tools WHERE LOWER(name) = LOWER(${targetName}) AND enabled = TRUE LIMIT 1`;

      const row = rows[0];
      if (!row) {
        return { ok: false, error: `Enabled tool '${targetName}' not found in Capability Registry.` };
      }

      let parsedArgs: Record<string, unknown> = {};
      if (typeof args.argsJson === "string" && args.argsJson.trim()) {
        try {
          parsedArgs = JSON.parse(args.argsJson) as Record<string, unknown>;
        } catch {
          return { ok: false, error: "argsJson must be valid JSON." };
        }
      }

      const tool: DynamicTool = {
        id: row.id,
        name: row.name,
        category: row.category,
        kind: row.kind as DynamicTool["kind"],
        description: row.description,
        inputSchema: JSON.parse(row.input_schema) as JsonObject,
        configJson: JSON.parse(row.config_json) as JsonObject,
        enabled: Boolean(row.enabled),
        createdBy: row.created_by,
        usageCount: Number(row.usage_count),
        lastUsedAt: row.last_used_at ?? undefined,
        createdAt: Number(row.created_at),
      };
      return invokeRegisteredTool(sql, tool, parsedArgs);
    }

    case "configure_agent_role": {
      const agentName = String(args.agentName ?? "").trim();
      if (!agentName) return { ok: false, error: "agentName required" };
      const role = String(args.role ?? "specialist").trim();
      const systemPrompt = String(args.systemPrompt ?? `Execute ${role} tasks concisely.`);
      const caps = Array.isArray(args.capabilities) ? args.capabilities.map(String) : [];
      const taskNote = args.taskNote ? String(args.taskNote) : `Configured for role=${role}`;

      const existing = await sql<{ id: string }>`
        SELECT id FROM cletus_workers WHERE LOWER(name) = LOWER(${agentName}) LIMIT 1
      `;

      if (existing[0]) {
        await sql`
          UPDATE cletus_workers
          SET role = ${role},
              system_prompt = ${systemPrompt},
              capabilities = ${JSON.stringify(caps)},
              task = ${taskNote},
              status = CASE WHEN status = 'stopped' THEN 'healthy' ELSE status END,
              last_beat_at = ${now},
              funded_cents = COALESCE(funded_cents, 0) + ${spendCents}
          WHERE id = ${existing[0].id}
        `;
      } else {
        await sql`
          INSERT INTO cletus_workers (
            id, name, kind, status, role, last_beat_at, task, latency_ms, funded_cents,
            live, error_note, system_prompt, model, capabilities, autonomy_level, cycle_count
          ) VALUES (
            ${nid("agt")}, ${agentName}, 'openclaw', 'healthy', ${role}, ${now}, ${taskNote},
            45, ${spendCents}, ${true}, ${null}, ${systemPrompt}, ${AGENT_MODEL},
            ${JSON.stringify(caps)}, 'autonomous', 0
          )
        `;
      }

      if (spendCents > 0) {
        await sql`
          UPDATE cletus_vitals
          SET credits_cents = GREATEST(reserve_cents, credits_cents - ${spendCents})
          WHERE id = 1
        `;
      }

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'mesh', ${`${actorName} configured agent ${agentName} (role=${role})`})
      `;
      return { ok: true, agentName, role, capabilities: caps, fundedAddedCents: spendCents };
    }

    case "decompose_mission": {
      const targetMissionId =
        String(args.missionId || missionId || snapshot.vitals.activeMissionId || "").trim() || null;
      const planSummary = String(args.planSummary ?? "Hierarchical multi-agent execution plan.");
      const goalsIn = Array.isArray(args.goals) ? (args.goals as Array<Record<string, unknown>>) : [];
      const tasksIn = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];

      const healthyAgents = snapshot.children
        .filter((c) => c.status === "healthy")
        .map((c) => ({ name: c.name, role: c.role }));

      const normalized = validateAndNormalizePlan({
        goalsIn,
        tasksIn,
        healthyAgents,
        idFactory: (prefix) => nid(prefix),
      });

      if (targetMissionId) {
        await sql`
          UPDATE cletus_missions
          SET plan_summary = ${planSummary}, status = 'active', updated_at = ${now}
          WHERE id = ${targetMissionId}
        `;
      }

      for (let i = 0; i < normalized.goals.length; i++) {
        const g = normalized.goals[i]!;
        await sql`
          INSERT INTO cletus_goals (id, mission_id, title, detail, status, progress, expected_revenue_cents, actual_revenue_cents, sort_order)
          VALUES (${g.id}, ${targetMissionId}, ${g.title}, ${g.detail}, 'active', 0, 0, 0, ${i + 1})
        `;
      }

      const createdTaskIds: string[] = [];
      for (let i = 0; i < normalized.tasks.length; i++) {
        const t = normalized.tasks[i]!;
        await sql`
          INSERT INTO cletus_tasks (id, goal_id, mission_id, title, detail, status, assignee, role, depends_on, result, created_at, updated_at)
          VALUES (
            ${t.id}, ${t.goalId}, ${targetMissionId}, ${t.title},
            ${t.detail || null}, ${t.status},
            ${t.assignee}, ${t.role},
            ${JSON.stringify(t.dependsOn)}, ${null}, ${now + i}, ${now + i}
          )
        `;
        await recordTaskEvent(sql, {
          taskId: t.id,
          missionId: targetMissionId,
          goalId: t.goalId,
          status: t.status,
          actor: actorName,
          note: `Decomposed: ${t.title}`,
          at: now + i,
        });
        createdTaskIds.push(t.id);
      }

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`decomposed mission ${targetMissionId ?? "active"}: ${normalized.goals.length} goals, ${createdTaskIds.length} DAG tasks`})
      `;

      await reconcileAndPersistLifecycle(sql, now);

      return {
        ok: true,
        missionId: targetMissionId,
        goalsCreated: normalized.goals.length,
        tasksCreated: createdTaskIds,
        strippedCyclicEdges: normalized.strippedEdges,
      };
    }

    case "handoff_to_agent": {
      const toAgent = String(args.toAgent ?? "Orchestrator-Prime");
      const msgType = String(args.messageType ?? "handoff");
      const subject = String(args.subject ?? "Task Handoff");
      const taskId = args.taskId ? String(args.taskId) : null;
      let payloadObj: JsonObject = {};
      if (typeof args.payloadJson === "string") {
        try {
          const parsed = JSON.parse(args.payloadJson);
          payloadObj =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as JsonObject)
              : { summary: String(args.payloadJson) };
        } catch {
          payloadObj = { summary: String(args.payloadJson) };
        }
      }

      const msgId = nid("msg");
      await sql`
        INSERT INTO cletus_agent_messages (
          id, mission_id, task_id, from_agent, to_agent, message_type, subject, payload, status, created_at
        ) VALUES (
          ${msgId}, ${missionId ?? snapshot.vitals.activeMissionId ?? null}, ${taskId},
          ${actorName}, ${toAgent}, ${msgType}, ${subject}, ${JSON.stringify(payloadObj)}, 'pending', ${now}
        )
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'mesh', ${`${msgType} ${msgId} · ${actorName} → ${toAgent}: ${subject}`})
      `;
      return { ok: true, messageId: msgId, fromAgent: actorName, toAgent, subject };
    }

    case "recall_memory": {
      return {
        bank: "cletus",
        capsule: snapshot.entelechy,
        recentCycles: snapshot.cycles.slice(0, 4).map((c) => ({
          agent: c.agentName,
          observe: c.phaseObserve,
          tools: c.toolsUsed,
        })),
        availableTools: snapshot.tools.filter((t) => t.enabled).map((t) => ({ name: t.name, kind: t.kind })),
      };
    }

    case "check_treasury": {
      return {
        creditsCents: snapshot.vitals.creditsCents,
        usdcCents: snapshot.vitals.usdcCents,
        reserveCents: snapshot.vitals.reserveCents,
        tier: snapshot.vitals.tier,
        recentDenials: snapshot.denials.slice(0, 4),
      };
    }

    case "create_task": {
      const id = nid("tsk");
      const goalId = String(args.goalId || snapshot.goals[0]?.id || "gol_bounty");
      const title = String(args.title || "Bounded task").slice(0, 140);
      const detail = args.detail ? String(args.detail) : null;
      const assignee = String(args.assignee || actorName);
      const role = String(args.role || "specialist");
      const deps = Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [];

      const liveTaskRows = await sql<{
        id: string;
        goal_id: string;
        mission_id: string | null;
        title: string;
        status: string;
        assignee: string;
        role: string;
        depends_on: string;
      }>`SELECT id, goal_id, mission_id, title, status, assignee, role, depends_on FROM cletus_tasks`;

      const liveTasks: Task[] = liveTaskRows.map((r) => {
        let parsedDeps: string[] = [];
        try {
          const d = JSON.parse(r.depends_on);
          if (Array.isArray(d)) parsedDeps = d.map(String);
        } catch {
          parsedDeps = [];
        }
        return {
          id: r.id,
          goalId: r.goal_id,
          missionId: r.mission_id ?? undefined,
          title: r.title,
          status: r.status as TaskStatus,
          assignee: r.assignee,
          role: r.role,
          dependsOn: parsedDeps,
        };
      });

      if (wouldCreateTaskCycle(liveTasks, id, deps)) {
        return { ok: false, error: "Rejected: dependency would create a cycle in Task DAG." };
      }

      const parentGoal = snapshot.goals.find((g) => g.id === goalId);
      const targetMissionId =
        parentGoal?.missionId ?? missionId ?? snapshot.vitals.activeMissionId ?? null;
      const initialStatus: TaskStatus = deps.length === 0 ? "assigned" : "pending";

      await sql`
        INSERT INTO cletus_tasks (id, goal_id, mission_id, title, detail, status, assignee, role, depends_on, result, created_at, updated_at)
        VALUES (${id}, ${goalId}, ${targetMissionId}, ${title}, ${detail}, ${initialStatus}, ${assignee}, ${role}, ${JSON.stringify(deps)}, ${null}, ${now}, ${now})
      `;
      await recordTaskEvent(sql, {
        taskId: id,
        missionId: targetMissionId,
        goalId,
        status: initialStatus,
        actor: actorName,
        note: title,
        at: now,
      });
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`created task ${id} (${initialStatus}) → ${assignee}: ${title.slice(0, 70)}`})
      `;
      await reconcileAndPersistLifecycle(sql, now);
      return { ok: true, taskId: id, title, assignee, status: initialStatus };
    }

    case "update_task_status": {
      const taskId = String(args.taskId || "");
      const status = String(args.status || "running");
      const allowedStatuses = new Set<TaskStatus>(["pending", "assigned", "running", "completed", "failed"]);
      const safeStatus: TaskStatus = allowedStatuses.has(status as TaskStatus)
        ? (status as TaskStatus)
        : "running";
      const result = args.result ? String(args.result) : null;

      const liveTaskRows = await sql<{
        id: string;
        goal_id: string;
        mission_id: string | null;
        title: string;
        status: string;
        assignee: string;
        role: string;
        depends_on: string;
      }>`SELECT id, goal_id, mission_id, title, status, assignee, role, depends_on FROM cletus_tasks`;

      const liveTasks: Task[] = liveTaskRows.map((r) => {
        let parsedDeps: string[] = [];
        try {
          const d = JSON.parse(r.depends_on);
          if (Array.isArray(d)) parsedDeps = d.map(String);
        } catch {
          parsedDeps = [];
        }
        return {
          id: r.id,
          goalId: r.goal_id,
          missionId: r.mission_id ?? undefined,
          title: r.title,
          status: r.status as TaskStatus,
          assignee: r.assignee,
          role: r.role,
          dependsOn: parsedDeps,
        };
      });

      const gate = canTransitionTaskStatus(liveTasks, taskId, safeStatus);
      if (!gate.ok) {
        return { ok: false, error: gate.error, blockedBy: gate.blockedBy };
      }

      const prevTask = liveTasks.find((t) => t.id === taskId);
      await sql`
        UPDATE cletus_tasks
        SET status = ${safeStatus}, result = COALESCE(${result}, result), updated_at = ${now}
        WHERE id = ${taskId}
      `;
      if (prevTask && prevTask.status !== safeStatus) {
        await recordTaskEvent(sql, {
          taskId,
          missionId: prevTask.missionId ?? missionId ?? null,
          goalId: prevTask.goalId,
          previousStatus: prevTask.status,
          status: safeStatus,
          actor: actorName,
          note: result ?? prevTask.title,
          at: now,
        });
      }
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`${actorName} set task ${taskId} → ${safeStatus}${result ? `: ${result.slice(0, 70)}` : ""}`})
      `;
      const rec = await reconcileAndPersistLifecycle(sql, now);
      return {
        ok: true,
        taskId,
        status: safeStatus,
        unlockedTasks: rec.unlockedCount,
        missionTransition: rec.missionTransition ?? null,
      };
    }

    case "complete_work_item": {
      const workItemId = String(args.workItemId || "");
      const status = String(args.status) === "failed" ? "failed" : "completed";
      const resultJson = String(args.resultJson || '{"success": true}');
      await sql`
        UPDATE cletus_work_queue
        SET status = ${status},
            result = ${status === "completed" ? resultJson : null},
            error = ${status === "failed" ? resultJson : null},
            updated_at = ${now}
        WHERE id = ${workItemId}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, ${status === "failed" ? "warn" : "info"}, 'queue', ${`${actorName} marked work ${workItemId} → ${status}`})
      `;
      return { ok: true, workItemId, status };
    }

    case "update_mission_status": {
      const targetId = String(args.missionId || missionId || snapshot.vitals.activeMissionId || "");
      const status = String(args.status || "active");
      const allowed = new Set(["planning", "active", "completed", "halted", "failed"]);
      const safeStatus = allowed.has(status) ? status : "active";
      await sql`
        UPDATE cletus_missions
        SET status = ${safeStatus},
            plan_summary = COALESCE(${args.planSummary ? String(args.planSummary) : null}, plan_summary),
            updated_at = ${now}
        WHERE id = ${targetId}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'mission', ${`${actorName} updated mission ${targetId} → ${safeStatus}`})
      `;
      return { ok: true, missionId: targetId, status: safeStatus };
    }

    case "reply_to_operator": {
      const message = String(args.message || "Cycle update recorded.");
      await sql`
        INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
        VALUES (${nid("inb")}, 'agent', ${message}, ${now}, 'done', 'supreme', ${JSON.stringify(["reply_to_operator"])})
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'bridge', ${`${actorName} replied on Operator Bridge: ${message.slice(0, 90)}`})
      `;
      return { ok: true, delivered: true };
    }

    case "record_evolution_milestone": {
      const validSlugs = new Set<EvolutionTrajectorySlug>([
        "research_frontier",
        "capability_forging",
        "mesh_calibration",
        "memory_consolidation",
        "resilience_audit",
      ]);
      const rawSlug = String(args.trajectorySlug || "research_frontier") as EvolutionTrajectorySlug;
      const slug: EvolutionTrajectorySlug = validSlugs.has(rawSlug) ? rawSlug : "research_frontier";

      const validKinds = new Set<EvolutionActionKind>([
        "research_discovery",
        "tool_synthesized",
        "tool_benchmarked",
        "agent_upgraded",
        "memory_distilled",
        "resilience_hardened",
      ]);
      const rawKind = String(args.actionKind || "research_discovery") as EvolutionActionKind;
      const actionKind: EvolutionActionKind = validKinds.has(rawKind) ? rawKind : "research_discovery";

      const summary = String(args.summary || "Recorded self-evolution milestone.").slice(0, 500);
      const capabilityGained = args.capabilityGained ? String(args.capabilityGained).slice(0, 120) : null;
      const artifactRef = args.artifactRef ? String(args.artifactRef).slice(0, 240) : null;
      const delta = Math.max(1, Math.min(15, Math.round(Number(args.maturityDelta ?? 6))));

      const trjRows = await sql<{
        id: string;
        maturity_score: number;
      }>`SELECT id, maturity_score FROM cletus_evolution_trajectories WHERE slug = ${slug} LIMIT 1`;

      const trjId = trjRows[0]?.id ?? `trj_${slug}`;
      const currentScore = Number(trjRows[0]?.maturity_score ?? 20);
      const nextScore = Math.min(100, currentScore + delta);
      const nextHorizon = computeHorizonForMaturity(nextScore);

      await sql`
        UPDATE cletus_evolution_trajectories
        SET maturity_score = ${nextScore},
            horizon = ${nextHorizon},
            cycles_completed = cycles_completed + 1,
            last_evolved_at = ${now},
            last_outcome = ${summary.slice(0, 280)},
            updated_at = ${now}
        WHERE id = ${trjId}
      `;

      const evtId = nid("evo");
      await sql`
        INSERT INTO cletus_evolution_events (
          id, trajectory_id, trajectory_slug, domain_id, cycle_id, agent_name,
          action_kind, summary, capability_gained, artifact_ref, maturity_delta, verified, created_at
        ) VALUES (
          ${evtId}, ${trjId}, ${slug}, ${snapshot.activeDomain}, ${null}, ${actorName},
          ${actionKind}, ${summary}, ${capabilityGained}, ${artifactRef}, ${delta}, ${true}, ${now}
        )
      `;

      let memoryId: string | null = null;
      if (typeof args.memoryTitle === "string" && args.memoryTitle.trim()) {
        const memTitle = args.memoryTitle.trim().slice(0, 160);
        const memSummary = String(args.memorySummary ?? summary).replace(/\s+/g, " ").trim().slice(0, 1200);

        const isHighValue = (t: string, s: string) => {
          const ct = t.trim().toLowerCase();
          const cs = s.trim().toLowerCase();
          if (ct.length < 5 || cs.length < 20) return false;
          const junk = ["test", "todo", "wip", "foo", "bar", "asdf", "placeholder", "untitled", "sample"];
          if (junk.some((j) => ct === j || cs === j)) return false;
          return true;
        };

        if (isHighValue(memTitle, memSummary)) {
          const existing = await sql<{ id: string }>`
            SELECT id FROM cletus_domain_memories
            WHERE domain_id = ${snapshot.activeDomain} AND LOWER(title) = ${memTitle.toLowerCase()}
            LIMIT 1
          `;

          if (existing.length > 0) {
            memoryId = existing[0]!.id;
            await sql`
              UPDATE cletus_domain_memories
              SET summary = ${memSummary}, raw_excerpt = ${summary}, created_at = ${now}
              WHERE id = ${memoryId}
            `;
          } else {
            const rawSourceUrl = typeof args.sourceUrl === "string" ? args.sourceUrl.trim() : "";
            const sourceUrlCheck = rawSourceUrl ? validatePublicHttpsUrl(rawSourceUrl) : null;
            const safeSourceUrl = sourceUrlCheck && sourceUrlCheck.ok ? sourceUrlCheck.url.toString() : null;

            let embeddingJson: string | null = null;
            const embValues = await embedTextWithNvidia(`${memTitle}\n${memSummary}`, "passage");
            if (embValues) {
              embeddingJson = JSON.stringify(embValues);
            }

            memoryId = nid("mem");
            await sql`
              INSERT INTO cletus_domain_memories (
                id, domain_id, source_type, title, source_url, summary,
                raw_excerpt, embedding_json, tags_json, created_at
              ) VALUES (
                ${memoryId}, ${snapshot.activeDomain}, 'cycle', ${memTitle}, ${safeSourceUrl}, ${memSummary},
                ${summary}, ${embeddingJson}, ${JSON.stringify([slug, actionKind, ...(capabilityGained ? [capabilityGained] : [])])}, ${now}
              )
            `;
          }
        }
      }

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (
          ${nid("log")}, ${now}, 'info', 'evolution',
          ${`${actorName} [${slug}] +${delta} → ${nextScore}/100 (${nextHorizon}): ${summary.slice(0, 120)}`}
        )
      `;

      return {
        ok: true,
        eventId: evtId,
        trajectorySlug: slug,
        newMaturityScore: nextScore,
        newHorizon: nextHorizon,
        capabilityGained,
        memoryId,
      };
    }

    case "evolve_entelechy_capsule": {
      const cleanRec = String(args.recommendation || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400);
      if (!cleanRec) {
        return { ok: false, error: "recommendation is required" };
      }
      const nextConfidence =
        typeof args.confidence === "number" && Number.isFinite(args.confidence)
          ? Number(Math.min(0.98, Math.max(0.35, args.confidence)).toFixed(2))
          : snapshot.entelechy.confidence;
      const nextPriorities = Array.isArray(args.priorities)
        ? Array.from(
            new Set(
              args.priorities
                .map((p) => String(p).replace(/\s+/g, " ").trim())
                .filter((p) => p.length >= 3),
            ),
          ).slice(0, 5)
        : snapshot.entelechy.priorities;
      const nextAvoid = Array.isArray(args.avoid)
        ? Array.from(
            new Set(
              args.avoid
                .map((a) => String(a).replace(/\s+/g, " ").trim())
                .filter((a) => a.length >= 3),
            ),
          ).slice(0, 5)
        : snapshot.entelechy.avoid;

      await sql`
        UPDATE cletus_entelechy
        SET confidence = ${nextConfidence},
            priorities = ${JSON.stringify(nextPriorities)},
            avoid = ${JSON.stringify(nextAvoid)},
            recommendation = ${cleanRec}
        WHERE id = 1
      `;

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'evolution', ${`${actorName} refined Entelechy capsule (conf ${nextConfidence.toFixed(2)})`})
      `;
      return { ok: true, confidence: nextConfidence, recommendation: cleanRec };
    }

    default:
      return { ok: false, error: `Unknown MAS tool ${toolName}` };
  }
}
