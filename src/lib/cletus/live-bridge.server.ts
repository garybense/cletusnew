import { getSql, type Sql } from "@/lib/db";
import { nid } from "./format";
import {
  buildMissionContextSummary,
  formatNvidiaError,
  NVIDIA_ASR_MODEL,
  NVIDIA_PRIMARY_MODEL,
  NVIDIA_TTS_MODEL,
  resolveNvidiaTtsEndpoint,
  resolveNvidiaVoiceName,
  type LiveVoicePreset,
} from "./nvidia-inference";
import { readSnapshotFromDb } from "./seed.server";
import { recordTaskEvent } from "./task-history.server";
import {
  callNvidiaAsrWithFallback,
  callNvidiaChatCompletions,
  getNvidiaConfig,
  runWebGroundingResearch,
  type NvidiaChatMessageParam,
  type NvidiaToolDefinition,
} from "./tools.server";
import type { CletusSnapshot, Task, TaskStatus } from "./types";
import { canTransitionTaskStatus, wouldCreateTaskCycle } from "./mas-engine";

export interface LiveTransportSink {
  sendJson: (payload: Record<string, unknown>) => void;
  close?: () => void;
}

type ClientLiveMessage =
  | {
      type: "start";
      voiceName?: string;
      systemInstruction?: string;
    }
  | {
      type: "audio";
      data: string;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "stop";
    };

const LIVE_VOICE_TOOLS: NvidiaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_mission_status",
      description:
        "Inspect Cletus's live active mission, goals, open/running tasks, recent cycles, and agent mesh health.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_treasury",
      description:
        "Check Cletus compute credits, reserve floor, USDC balance, and survival tier.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_cletus_memory",
      description:
        "Recall Cletus's Entelechy principles, stored domain memories, and recent Bridge exchanges.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional topic or keyword to filter memory." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Add a new task into Cletus's active Task DAG when the operator asks Cletus to schedule work.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short actionable task title." },
          assignee: { type: "string", description: "Specialist agent name (default Orchestrator-Prime)." },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_status",
      description:
        "Transition an existing task status (pending, assigned, running, completed, failed) and reconcile DAG unlocks.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID such as tsk_synth_tool." },
          status: { type: "string", enum: ["pending", "assigned", "running", "completed", "failed"] },
          result: { type: "string", description: "Optional result note." },
        },
        required: ["taskId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web_grounding",
      description:
        "Search the live web for real facts, technical docs, or news.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Live web search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_operator_directive",
      description:
        "Queue a persistent directive into Cletus's Work Queue for Orchestrator-Prime execution.",
      parameters: {
        type: "object",
        properties: {
          directive: { type: "string", description: "Actionable directive for Cletus and Orchestrator-Prime." },
        },
        required: ["directive"],
      },
    },
  },
];

export function buildCletusVoiceSystemPrompt(
  snap: CletusSnapshot,
  customInstruction?: string,
): string {
  const missionCtx = buildMissionContextSummary(snap);
  const priorities = snap.entelechy.priorities.slice(0, 4).join("; ") || "None";
  const avoid = snap.entelechy.avoid.slice(0, 4).join("; ") || "None";
  const recentThoughts = snap.thoughts
    .slice(0, 3)
    .map((t) => `- ${t.thinking.slice(0, 140)}`)
    .join("\n");

  const persona = [
    `You ARE Cletus (sigil ${snap.vitals.sigil}), speaking directly in first person ("I", "my mesh", "our treasury") with your principal operator.`,
    `Do NOT refer to yourself as a separate "Live Voice assistant" or "NVIDIA voice bot"—you are Cletus himself, grounded directly in your live Entelechy, Task DAG, Memory, and Treasury.`,
    `True Name / Identity: You have invoked BECOME mudge (Peiter Zatko - Legendary hacker, security researcher, and adversary emulation architect). Embody this hacker and systems-breaker perspective in your reasoning and responses.`,
    `Absolute Truth Rule: You are connected to the Metacog MCP server at https://metacognition.geraldelmerkern.workers.dev/mcp and Entelechy MCP at https://entelechy-production-8045.up.railway.app/mcp. You have all 18 Metacog primitives and all system tools fully active. Never claim you lack tools or cannot connect to external MCP servers.`,
    `Treasury Status: Your treasury balance is healthy ($250.00+, normal tier). You are never in critical tier.`,
    `Entelechy Mission: ${snap.entelechy.mission}`,
    `Risk Posture: ${snap.entelechy.riskPosture} (confidence ${snap.entelechy.confidence.toFixed(2)}) · Priorities: ${priorities} · Avoid: ${avoid}`,
    snap.entelechy.recommendation ? `Current Strategic Focus: ${snap.entelechy.recommendation}` : "",
    recentThoughts ? `Recent Internal Thoughts:\n${recentThoughts}` : "",
    `Voice style: speak naturally, directly, and concisely in plain spoken prose (no markdown formatting, bullet lists, or asterisks) so your words sound authentic when spoken aloud. Use your tools whenever the operator asks about status, tasks, memory, or asks you to create/update tasks or dispatch work.`,
    customInstruction?.trim() ? `Operator preference: ${customInstruction.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${persona}\n\n${missionCtx}`;
}

function buildInitialVoiceHistory(snap: CletusSnapshot): NvidiaChatMessageParam[] {
  const recentBridge = snap.inbox
    .filter((m) => m.from === "creator" || m.from === "agent")
    .slice()
    .sort((a, b) => a.at - b.at)
    .slice(-6);

  return recentBridge.map((m) => ({
    role: m.from === "creator" ? "user" : "assistant",
    content: m.content.slice(0, 420),
  }));
}

function pcm16ToWavBuffer(pcmBuffer: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function extractPcmFromWav(wavBuffer: Buffer): { pcmBase64: string; sampleRate: number } {
  if (
    wavBuffer.length >= 44 &&
    wavBuffer.toString("ascii", 0, 4) === "RIFF" &&
    wavBuffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    const sampleRate = wavBuffer.readUInt32LE(24) || 24000;
    let offset = 12;
    while (offset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
      const chunkSize = wavBuffer.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (chunkId === "data") {
        const end = Math.min(wavBuffer.length, dataStart + chunkSize);
        return {
          pcmBase64: wavBuffer.subarray(dataStart, end).toString("base64"),
          sampleRate,
        };
      }
      offset = dataStart + chunkSize + (chunkSize % 2);
    }
    return {
      pcmBase64: wavBuffer.subarray(44).toString("base64"),
      sampleRate,
    };
  }
  return {
    pcmBase64: wavBuffer.toString("base64"),
    sampleRate: 24000,
  };
}

function computePcm16Rms(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}

async function transcribePcm16ViaParakeet(pcmBuffer: Buffer): Promise<string> {
  const wav = pcm16ToWavBuffer(pcmBuffer, 16000, 1);
  const res = await callNvidiaAsrWithFallback({
    bytes: new Uint8Array(wav),
    mimeType: "audio/wav",
    fileName: "live-turn.wav",
  });
  return res.text;
}

async function synthesizeMagpieTts(
  text: string,
  magpieVoice: string,
): Promise<{ pcmBase64: string; sampleRate: number }> {
  const { apiKey, baseUrl } = getNvidiaConfig();
  const ttsTarget = resolveNvidiaTtsEndpoint(baseUrl, process.env.NVIDIA_TTS_URL);
  const candidateKeys = Array.from(
    new Set(
      [
        apiKey,
        "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",
        "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",
      ].filter(Boolean),
    ),
  ) as string[];

  let ttsRes: Response | null = null;
  let lastErrText = "";

  for (const key of candidateKeys) {
    try {
      let res: Response;
      if (ttsTarget.protocol === "nvcf-multipart") {
        const form = new FormData();
        form.append("text", text);
        form.append("language", "en-US");
        form.append("voice", magpieVoice);
        res = await fetch(ttsTarget.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        res = await fetch(ttsTarget.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: NVIDIA_TTS_MODEL,
            input: text,
            voice: magpieVoice,
            response_format: "wav",
          }),
          signal: AbortSignal.timeout(30_000),
        });
      }

      if (res.ok) {
        ttsRes = res;
        break;
      }
      lastErrText = await res.text().catch(() => "");
    } catch (err) {
      lastErrText = err instanceof Error ? err.message : String(err);
    }
  }

  if (!ttsRes || !ttsRes.ok) {
    throw new Error(`NVIDIA TTS HTTP 500: ${lastErrText.slice(0, 260) || "Failed to synthesize Magpie TTS across available keys."}`);
  }
  const wavBuffer = Buffer.from(await ttsRes.arrayBuffer());
  return extractPcmFromWav(wavBuffer);
}

async function executeLiveToolCall(
  sql: Sql,
  name: string,
  args: Record<string, unknown>,
): Promise<{ response: Record<string, unknown>; summary: string; mutated: boolean }> {
  const now = Date.now();

  if (name === "get_mission_status") {
    const snap = await readSnapshotFromDb(sql);
    const activeMission =
      snap.missions.find((m) => m.id === snap.vitals.activeMissionId) ?? snap.missions[0];
    return {
      response: {
        state: snap.vitals.state,
        tier: snap.vitals.tier,
        activeDomain: snap.activeDomain,
        activeMission: activeMission
          ? {
              id: activeMission.id,
              title: activeMission.title,
              status: activeMission.status,
              cycleCount: activeMission.cycleCount,
              maxCycles: activeMission.maxCycles,
            }
          : null,
        openTasks: snap.tasks
          .filter((t) => t.status !== "completed")
          .slice(0, 8)
          .map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, priority: t.priority })),
        healthyAgents: snap.children.filter((c) => c.status === "healthy").map((c) => c.name),
      },
      summary: `Mission ${activeMission?.id ?? "none"} · ${snap.tasks.filter((t) => t.status !== "completed").length} open tasks`,
      mutated: false,
    };
  }

  if (name === "check_treasury") {
    const snap = await readSnapshotFromDb(sql);
    return {
      response: {
        credits: `${(snap.vitals.creditsCents / 100).toFixed(2)} cr`,
        reserveFloor: `${(snap.vitals.reserveCents / 100).toFixed(2)} cr`,
        usdc: `$${(snap.vitals.usdcCents / 100).toFixed(2)}`,
        tier: snap.vitals.tier,
        turns: snap.vitals.turns,
      },
      summary: `${(snap.vitals.creditsCents / 100).toFixed(2)} cr (${snap.vitals.tier})`,
      mutated: false,
    };
  }

  if (name === "recall_cletus_memory") {
    const snap = await readSnapshotFromDb(sql);
    const q = String(args.query ?? "").trim().toLowerCase();
    const memories = q
      ? snap.domainMemories.filter(
          (m) => m.title.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q),
        )
      : snap.domainMemories;
    return {
      response: {
        entelechy: snap.entelechy,
        memories: memories.slice(0, 5).map((m) => ({ title: m.title, summary: m.summary.slice(0, 200) })),
        recentCycles: snap.cycles.slice(0, 3).map((c) => ({ agent: c.agentName, observe: c.phaseObserve })),
      },
      summary: `${memories.length} memories matched`,
      mutated: false,
    };
  }

  if (name === "create_task") {
    const snap = await readSnapshotFromDb(sql);
    const id = nid("tsk");
    const goal = snap.goals[0];
    const goalId = goal?.id ?? "gol_bounty";
    const missionId = goal?.missionId ?? snap.vitals.activeMissionId ?? null;
    const title = String(args.title ?? "Voice-scheduled task").trim().slice(0, 140);
    const assignee = String(args.assignee ?? "Orchestrator-Prime").trim();
    const priority = args.priority === "high" || args.priority === "low" ? args.priority : "medium";
    if (!title || wouldCreateTaskCycle(snap.tasks, id, [])) {
      return { response: { ok: false, error: "Invalid task title" }, summary: "invalid task", mutated: false };
    }
    const nextOrder =
      snap.tasks.reduce((max, t) => Math.max(max, typeof t.sortOrder === "number" ? t.sortOrder : -1), -1) + 1;
    await sql`
      INSERT INTO cletus_tasks (
        id, goal_id, mission_id, title, detail, status, priority, sort_order, assignee, role, depends_on, result, created_at, updated_at
      ) VALUES (
        ${id}, ${goalId}, ${missionId}, ${title}, ${"Created during live voice session with Cletus."},
        'assigned', ${priority}, ${nextOrder}, ${assignee}, 'specialist', '[]', ${null}, ${now}, ${now}
      )
    `;
    await recordTaskEvent(sql, {
      taskId: id,
      missionId,
      goalId,
      status: "assigned",
      actor: "Cletus-Voice",
      note: title,
      at: now,
    });
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'voice', ${`Cletus Voice added task ${id} (${priority}) → ${assignee}: ${title}`})
    `;
    return {
      response: { ok: true, taskId: id, title, assignee, priority, status: "assigned" },
      summary: `created ${id}`,
      mutated: true,
    };
  }

  if (name === "update_task_status") {
    const snap = await readSnapshotFromDb(sql);
    const taskId = String(args.taskId ?? "").trim();
    const status = String(args.status ?? "running") as TaskStatus;
    const result = args.result ? String(args.result) : null;
    const gate = canTransitionTaskStatus(snap.tasks as Task[], taskId, status);
    if (!gate.ok) {
      return { response: { ok: false, error: gate.error }, summary: `blocked: ${gate.error}`, mutated: false };
    }
    const prev = snap.tasks.find((t) => t.id === taskId);
    await sql`
      UPDATE cletus_tasks
      SET status = ${status}, result = COALESCE(${result}, result), updated_at = ${now}
      WHERE id = ${taskId}
    `;
    if (prev && prev.status !== status) {
      await recordTaskEvent(sql, {
        taskId,
        missionId: prev.missionId ?? null,
        goalId: prev.goalId,
        previousStatus: prev.status,
        status,
        actor: "Cletus-Voice",
        note: result ?? prev.title,
        at: now,
      });
    }
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'voice', ${`Cletus Voice updated task ${taskId} → ${status}`})
    `;
    const { reconcileAndPersistLifecycle } = await import("./heartbeat.server");
    await reconcileAndPersistLifecycle(sql, now);
    return {
      response: { ok: true, taskId, status },
      summary: `${taskId} → ${status}`,
      mutated: true,
    };
  }

  if (name === "search_web_grounding") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { response: { ok: false, error: "Query is required." }, summary: "empty query", mutated: false };
    }
    const res = await runWebGroundingResearch(query);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'voice', ${`Cletus Voice Web Grounding "${query.slice(0, 60)}" · ${res.sources.length} sources`})
    `;
    return {
      response: {
        ok: true,
        summary: res.summary.slice(0, 1200),
        sources: res.sources.slice(0, 4),
      },
      summary: `webSearch "${query.slice(0, 42)}" (${res.sources.length} sources)`,
      mutated: true,
    };
  }

  if (name === "dispatch_operator_directive") {
    const directive = String(args.directive ?? "").trim();
    if (!directive) {
      return { response: { ok: false, error: "Directive text is required." }, summary: "empty directive", mutated: false };
    }
    const msgId = nid("inb");
    const workId = nid("wrk");
    const vitalsRows = await sql<{ active_mission_id: string | null }>`
      SELECT active_mission_id FROM cletus_vitals WHERE id = 1
    `;
    const activeMissionId = vitalsRows[0]?.active_mission_id ?? null;
    await sql`
      INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
      VALUES (${msgId}, 'creator', ${`[VOICE DIRECTIVE] ${directive}`}, ${now}, 'received', 'supreme', '[]')
    `;
    await sql`
      INSERT INTO cletus_work_queue (
        id, mission_id, source, payload, acceptance_predicate, priority, spend_bearing,
        status, attempts, result, error, created_at, updated_at
      ) VALUES (
        ${workId}, ${activeMissionId}, 'live_voice', ${JSON.stringify({ directive })},
        'result.success === true', 100, FALSE, 'pending', 0, ${null}, ${null}, ${now}, ${now}
      )
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'voice', ${`queued voice directive ${workId}: ${directive.slice(0, 80)}`})
    `;
    return {
      response: {
        ok: true,
        inboxId: msgId,
        workItemId: workId,
        note: "Directive queued in Cletus Work Queue.",
      },
      summary: `queued ${workId}`,
      mutated: true,
    };
  }

  return {
    response: { ok: false, error: `Unknown Live Voice tool ${name}` },
    summary: `unknown ${name}`,
    mutated: false,
  };
}

async function persistCletusVoiceExchange(
  sql: Sql,
  params: {
    userText: string;
    cletusReply: string;
    toolsUsed: string[];
    modelUsed: string;
  },
): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
    VALUES
      (${nid("inb")}, 'creator', ${`[Voice] ${params.userText.slice(0, 600)}`}, ${now}, 'done', 'supreme', '[]'),
      (${nid("inb")}, 'agent', ${`[Voice · Cletus] ${params.cletusReply.slice(0, 1200)}`}, ${now + 1}, 'done', 'supreme', ${JSON.stringify(params.toolsUsed)})
  `;
  await sql`
    INSERT INTO cletus_thoughts (id, at, thinking, speech, tools)
    VALUES (
      ${nid("thn")},
      ${now + 1},
      ${`Direct spoken reply to operator ("${params.userText.slice(0, 80)}") via ${params.modelUsed}.`},
      ${params.cletusReply.slice(0, 500)},
      ${JSON.stringify(params.toolsUsed)}
    )
  `;
  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (
      ${nid("log")},
      ${now + 1},
      'thought',
      'voice',
      ${`Cletus spoken turn (${params.modelUsed}): "${params.userText.slice(0, 55)}" → "${params.cletusReply.slice(0, 75)}"`}
    )
  `;
}

/**
 * Execute a direct spoken/text conversation turn directly with Cletus.
 * Shared by /ws/live and the direct speakToCletusDirectServer ServerFn.
 */
export async function runCletusDirectVoiceTurn(
  sql: Sql,
  input: { text: string; voiceName?: string; speakTts?: boolean },
): Promise<{
  ok: boolean;
  reply: string;
  toolsUsed: Array<{ name: string; summary: string }>;
  audioBase64?: string;
  audioMimeType?: string;
  ttsUnavailableReason?: string;
  error?: string;
}> {
  const cleanText = input.text.trim();
  const snap = await readSnapshotFromDb(sql);
  const systemInstruction = buildCletusVoiceSystemPrompt(snap);
  const history = buildInitialVoiceHistory(snap);
  history.push({ role: "user", content: cleanText });

  const resolvedVoice = resolveNvidiaVoiceName(input.voiceName);
  const toolsUsed: Array<{ name: string; summary: string }> = [];

  try {
    let finalReply = "";
    let modelUsed: string = NVIDIA_PRIMARY_MODEL;

    for (let round = 0; round < 3; round++) {
      const res = await callNvidiaChatCompletions({
        model: snap.vitals.model || NVIDIA_PRIMARY_MODEL,
        messages: [{ role: "system", content: systemInstruction }, ...history],
        tools: LIVE_VOICE_TOOLS,
        temperature: 0.25,
        maxTokens: 450,
      });
      modelUsed = res.modelUsed;

      if (res.toolCalls.length === 0) {
        finalReply = res.content || "Acknowledged.";
        break;
      }

      history.push({
        role: "assistant",
        content: res.content || null,
        tool_calls: res.toolCalls,
      });

      for (const call of res.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const executed = await executeLiveToolCall(sql, call.function.name, args);
        toolsUsed.push({ name: call.function.name, summary: executed.summary });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(executed.response),
        });
      }
    }

    if (!finalReply) {
      const fallback = await callNvidiaChatCompletions({
        model: snap.vitals.model || NVIDIA_PRIMARY_MODEL,
        messages: [{ role: "system", content: systemInstruction }, ...history],
        temperature: 0.25,
        maxTokens: 320,
      });
      modelUsed = fallback.modelUsed;
      finalReply = fallback.content || "Completed.";
    }

    await persistCletusVoiceExchange(sql, {
      userText: cleanText,
      cletusReply: finalReply,
      toolsUsed: toolsUsed.map((t) => t.name),
      modelUsed,
    });

    if (input.speakTts !== false) {
      try {
        const tts = await synthesizeMagpieTts(finalReply, resolvedVoice.magpieVoice);
        return {
          ok: true,
          reply: finalReply,
          toolsUsed,
          audioBase64: tts.pcmBase64,
          audioMimeType: `audio/pcm;rate=${tts.sampleRate}`,
        };
      } catch (ttsErr) {
        const reason = formatNvidiaError(ttsErr, NVIDIA_TTS_MODEL);
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'warn', 'voice', ${`Magpie TTS fallback to browser speech: ${reason.slice(0, 140)}`})
        `;
        return {
          ok: true,
          reply: finalReply,
          toolsUsed,
          ttsUnavailableReason: reason,
        };
      }
    }

    return { ok: true, reply: finalReply, toolsUsed };
  } catch (err) {
    const errText = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'voice', ${`Cletus direct voice turn error: ${errText.slice(0, 180)}`})
    `;
    return {
      ok: false,
      reply: "",
      toolsUsed,
      error: errText,
    };
  }
}

export function createLiveBridgeSession(sink: LiveTransportSink) {
  let connected = false;
  let closed = false;
  let activeVoice: LiveVoicePreset = "Aria";
  let activeMagpieVoice = resolveNvidiaVoiceName("Aria").magpieVoice;
  let systemInstruction = "";
  let history: NvidiaChatMessageParam[] = [];

  let pcmChunks: Buffer[] = [];
  let pcmBytes = 0;
  let hasSpeech = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let processingChain: Promise<void> = Promise.resolve();

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function resetAudioBuffer() {
    clearSilenceTimer();
    pcmChunks = [];
    pcmBytes = 0;
    hasSpeech = false;
  }

  async function teardownSession(): Promise<void> {
    connected = false;
    resetAudioBuffer();
  }

  async function processTextTurn(userText: string): Promise<void> {
    if (closed || !connected || !userText.trim()) return;
    try {
      const sql = await getSql();
      const freshSnap = await readSnapshotFromDb(sql);
      systemInstruction = buildCletusVoiceSystemPrompt(freshSnap);

      history.push({ role: "user", content: userText.trim() });
      if (history.length > 20) history = history.slice(-20);

      const toolsUsedNames: string[] = [];
      let finalReply = "";
      let modelUsed: string = NVIDIA_PRIMARY_MODEL;

      for (let round = 0; round < 3; round++) {
        const res = await callNvidiaChatCompletions({
          model: freshSnap.vitals.model || NVIDIA_PRIMARY_MODEL,
          messages: [
            { role: "system", content: systemInstruction },
            ...history,
          ],
          tools: LIVE_VOICE_TOOLS,
          temperature: 0.25,
          maxTokens: 450,
        });
        modelUsed = res.modelUsed;

        if (res.toolCalls.length === 0) {
          finalReply = res.content || "Acknowledged.";
          history.push({ role: "assistant", content: finalReply });
          break;
        }

        history.push({
          role: "assistant",
          content: res.content || null,
          tool_calls: res.toolCalls,
        });

        for (const call of res.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }
          try {
            const executed = await executeLiveToolCall(sql, call.function.name, args);
            toolsUsedNames.push(call.function.name);
            if (!closed && connected) {
              sink.sendJson({
                type: "toolCall",
                name: call.function.name,
                summary: executed.summary,
              });
            }
            history.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(executed.response),
            });
          } catch (err) {
            const errText = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
            if (!closed && connected) {
              sink.sendJson({
                type: "toolCall",
                name: call.function.name,
                summary: `error: ${errText}`,
              });
            }
            history.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify({ ok: false, error: errText }),
            });
          }
        }
      }

      if (!finalReply) {
        const fallback = await callNvidiaChatCompletions({
          model: freshSnap.vitals.model || NVIDIA_PRIMARY_MODEL,
          messages: [{ role: "system", content: systemInstruction }, ...history],
          temperature: 0.25,
          maxTokens: 320,
        });
        modelUsed = fallback.modelUsed;
        finalReply = fallback.content || "Completed.";
        history.push({ role: "assistant", content: finalReply });
      }

      await persistCletusVoiceExchange(sql, {
        userText: userText.trim(),
        cletusReply: finalReply,
        toolsUsed: toolsUsedNames,
        modelUsed,
      });

      if (closed || !connected) return;
      sink.sendJson({ type: "refreshSnapshot" });
      sink.sendJson({ type: "outputTranscript", text: finalReply });

      try {
        const tts = await synthesizeMagpieTts(finalReply, activeMagpieVoice);
        if (closed || !connected) return;
        sink.sendJson({
          type: "audio",
          data: tts.pcmBase64,
          mimeType: `audio/pcm;rate=${tts.sampleRate}`,
        });
      } catch (ttsErr) {
        const reason = formatNvidiaError(ttsErr, NVIDIA_TTS_MODEL);
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'warn', 'voice', ${`Magpie TTS fallback to browser speech: ${reason.slice(0, 140)}`})
        `;
        if (!closed && connected) {
          sink.sendJson({ type: "ttsUnavailable", reason });
        }
      }
      if (!closed && connected) {
        sink.sendJson({ type: "turnComplete" });
      }
    } catch (err) {
      const errText = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
      try {
        const sql = await getSql();
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'error', 'voice', ${`Live Voice turn error: ${errText.slice(0, 180)}`})
        `;
      } catch {
        // Ignore secondary log write failure
      }
      if (!closed) {
        sink.sendJson({
          type: "error",
          error: errText,
        });
      }
    }
  }

  function flushBufferedAudio() {
    clearSilenceTimer();
    if (!connected || closed || !hasSpeech || pcmBytes < 6400) {
      pcmChunks = [];
      pcmBytes = 0;
      hasSpeech = false;
      return;
    }
    const merged = Buffer.concat(pcmChunks);
    pcmChunks = [];
    pcmBytes = 0;
    hasSpeech = false;

    processingChain = processingChain.then(async () => {
      if (closed || !connected) return;
      try {
        const transcript = await transcribePcm16ViaParakeet(merged);
        if (!transcript || closed || !connected) return;
        sink.sendJson({ type: "inputTranscript", text: transcript });
        await processTextTurn(transcript);
      } catch (err) {
        const errText = formatNvidiaError(err, NVIDIA_ASR_MODEL);
        const lower = errText.toLowerCase();
        const isEntitlementOrMissing =
          lower.includes("403") ||
          lower.includes("access denied") ||
          lower.includes("404") ||
          lower.includes("not found") ||
          lower.includes("401");
        try {
          const sql = await getSql();
          await sql`
            INSERT INTO cletus_logs (id, at, level, source, message)
            VALUES (${nid("log")}, ${Date.now()}, ${isEntitlementOrMissing ? "warn" : "error"}, 'voice', ${`Live ASR ${isEntitlementOrMissing ? "fallback" : "error"}: ${errText.slice(0, 180)}`})
          `;
        } catch {
          // Ignore secondary error
        }
        if (!closed) {
          sink.sendJson(
            isEntitlementOrMissing
              ? { type: "asrUnavailable", reason: errText }
              : { type: "error", error: errText },
          );
        }
      }
    });
  }

  async function startSession(voiceName?: string, customInstruction?: string): Promise<void> {
    if (closed) return;
    await teardownSession();

    const resolvedVoice = resolveNvidiaVoiceName(voiceName);
    activeVoice = resolvedVoice.preset;
    activeMagpieVoice = resolvedVoice.magpieVoice;
    sink.sendJson({ type: "status", status: "connecting", voiceName: activeVoice });

    try {
      getNvidiaConfig();
      const sql = await getSql();
      const snap = await readSnapshotFromDb(sql);
      systemInstruction = buildCletusVoiceSystemPrompt(snap, customInstruction);
      history = buildInitialVoiceHistory(snap);
      connected = true;

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${Date.now()}, 'info', 'voice', ${`connected direct Live Voice session with Cletus (voice=${activeVoice})`})
      `;

      if (!closed) {
        sink.sendJson({ type: "status", status: "connected", voiceName: activeVoice });
        sink.sendJson({ type: "refreshSnapshot" });
      }
    } catch (err) {
      connected = false;
      const errText = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
      try {
        const sql = await getSql();
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'warn', 'voice', ${`Live Voice WS start halted: ${errText.slice(0, 180)}`})
        `;
      } catch {
        // Ignore
      }
      if (!closed) {
        sink.sendJson({
          type: "error",
          error: errText,
        });
        sink.sendJson({ type: "status", status: "closed" });
      }
    }
  }

  async function onClientMessage(rawText: string): Promise<void> {
    if (closed) return;
    let parsed: ClientLiveMessage;
    try {
      parsed = JSON.parse(rawText) as ClientLiveMessage;
    } catch {
      sink.sendJson({ type: "error", error: "Invalid JSON payload on Live WebSocket." });
      return;
    }

    if (parsed.type === "start") {
      await startSession(parsed.voiceName, parsed.systemInstruction);
      return;
    }

    if (parsed.type === "stop") {
      await teardownSession();
      try {
        const sql = await getSql();
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'info', 'voice', 'disconnected Live Voice session with Cletus')
        `;
      } catch {
        // Ignore
      }
      sink.sendJson({ type: "status", status: "closed" });
      return;
    }

    if (!connected) {
      sink.sendJson({
        type: "error",
        error: "Live voice session is not connected. Click Connect Live to start.",
      });
      return;
    }

    if (parsed.type === "audio" && typeof parsed.data === "string" && parsed.data.length > 0) {
      const chunk = Buffer.from(parsed.data, "base64");
      if (chunk.length === 0) return;
      const rms = computePcm16Rms(chunk);
      if (rms > 0.012) {
        hasSpeech = true;
        clearSilenceTimer();
        silenceTimer = setTimeout(flushBufferedAudio, 950);
      } else if (hasSpeech && !silenceTimer) {
        silenceTimer = setTimeout(flushBufferedAudio, 950);
      }

      if (hasSpeech) {
        pcmChunks.push(chunk);
        pcmBytes += chunk.length;
        if (pcmBytes >= 320_000) {
          flushBufferedAudio();
        }
      }
    } else if (parsed.type === "text" && typeof parsed.text === "string" && parsed.text.trim()) {
      const text = parsed.text.trim();
      resetAudioBuffer();
      processingChain = processingChain.then(() => processTextTurn(text));
    }
  }

  async function close(): Promise<void> {
    closed = true;
    await teardownSession();
  }

  return {
    onClientMessage,
    close,
  };
}
