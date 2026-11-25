import type { Sql } from "@/lib/db";
import {
  buildDomainActivationPlan,
  getDomainPack,
  rankDomainMemories,
  type RankedMemoryResult,
} from "./domains";
import { nid } from "./format";
import {
  formatNvidiaError,
  NVIDIA_PRIMARY_MODEL,
  NVIDIA_TTS_MODEL,
  resolveNvidiaTtsEndpoint,
  resolveNvidiaVoiceName,
} from "./nvidia-inference";
import { readSnapshotFromDb } from "./seed.server";
import { recordTaskEvent } from "./task-history.server";
import {
  callNvidiaChatCompletions,
  embedTextWithNvidia,
  getNvidiaConfig,
  invokeRegisteredTool,
  runUrlContextAnalysis,
} from "./tools.server";
import type {
  AudioBriefing,
  DomainId,
  DomainMemoryItem,
  DomainMemorySourceType,
  DynamicTool,
  JsonObject,
} from "./types";

function summarizeConnectorOutput(toolName: string, output: Record<string, unknown>): string {
  if (output.ok === false) {
    return `Connector ${toolName} returned error: ${String(output.error ?? "Unknown error")}`;
  }
  switch (toolName) {
    case "search_arxiv": {
      const papers = Array.isArray(output.papers) ? (output.papers as Array<Record<string, unknown>>) : [];
      return papers.length > 0
        ? `Indexed ${papers.length} arXiv preprints: ${papers
            .slice(0, 3)
            .map((p) => `${String(p.id ?? "")}: ${String(p.title ?? "").slice(0, 80)}`)
            .join(" | ")}`
        : "No matching arXiv preprints returned.";
    }
    case "search_github_repos": {
      const repos = Array.isArray(output.repositories)
        ? (output.repositories as Array<Record<string, unknown>>)
        : [];
      return repos.length > 0
        ? `Evaluated ${repos.length} GitHub repos: ${repos
            .slice(0, 3)
            .map((r) => `${String(r.fullName ?? "")} (${String(r.stars ?? 0)}★)`)
            .join(" | ")}`
        : "No matching GitHub repositories returned.";
    }
    case "query_pubmed_trials": {
      const articles = Array.isArray(output.pubmedArticles)
        ? (output.pubmedArticles as Array<Record<string, unknown>>)
        : [];
      const trials = Array.isArray(output.clinicalTrials)
        ? (output.clinicalTrials as Array<Record<string, unknown>>)
        : [];
      const topStudies = trials
        .slice(0, 2)
        .map((s) => `${String(s.nctId ?? "")} (${String(s.status ?? "")})`)
        .join(", ");
      const topPmids = articles
        .slice(0, 2)
        .map((a) => `PMID:${String(a.pmid ?? "")}`)
        .join(", ");
      return `PubMed (${articles.length}: ${topPmids || "none"}) · ClinicalTrials.gov (${trials.length}: ${topStudies || "none"})`;
    }
    case "query_openfda_events": {
      const events = Array.isArray(output.events) ? (output.events as Array<Record<string, unknown>>) : [];
      return `OpenFDA FAERS matched ${String(output.totalMatches ?? events.length)} total reports (${events.length} sampled): ${events
        .slice(0, 2)
        .map((e) => `#${String(e.reportId ?? "")} [${Array.isArray(e.reactions) ? e.reactions.slice(0, 2).join(", ") : ""}]`)
        .join(" | ")}`;
    }
    case "query_usgs_weather": {
      const quakes = Array.isArray(output.earthquakes)
        ? (output.earthquakes as Array<Record<string, unknown>>)
        : [];
      const weather = (output.weather as Record<string, unknown> | null) ?? null;
      const topQuake = quakes[0]
        ? `M${String(quakes[0].magnitude ?? "?")} ${String(quakes[0].place ?? "")}`
        : "none above threshold";
      const meteoStr = weather
        ? `${String(weather.temperature_2m ?? "?")}°C, wind ${String(weather.wind_speed_10m ?? "?")} km/h`
        : "weather unavailable";
      return `USGS Seismic (${quakes.length}, latest: ${topQuake}) · Open-Meteo: ${meteoStr}`;
    }
    case "query_nvd_cves": {
      const cves = Array.isArray(output.cves) ? (output.cves as Array<Record<string, unknown>>) : [];
      const ledger = Array.isArray(output.treasuryDebtLedger)
        ? (output.treasuryDebtLedger as Array<Record<string, unknown>>)
        : [];
      const cveSummary = cves
        .slice(0, 2)
        .map((c) => `${String(c.id ?? "")} (CVSS ${String(c.cvssScore ?? "n/a")})`)
        .join(", ");
      const treasSummary = ledger[0]?.record_date
        ? `US Treasury ledger ${String(ledger[0].record_date)}`
        : "Treasury feed checked";
      return `NIST NVD (${cves.length}: ${cveSummary || "none"}) · ${treasSummary}`;
    }
    case "query_federal_register": {
      const docs = Array.isArray(output.federalRegisterDocuments)
        ? (output.federalRegisterDocuments as Array<Record<string, unknown>>)
        : [];
      const works = Array.isArray(output.openAlexWorks)
        ? (output.openAlexWorks as Array<Record<string, unknown>>)
        : [];
      return `Federal Register (${docs.length}: ${docs
        .slice(0, 2)
        .map((d) => `${String(d.documentNumber ?? "")} ${String(d.title ?? "").slice(0, 50)}`)
        .join("; ")}) · OpenAlex (${works.length} works)`;
    }
    default: {
      return `${toolName} completed: ${JSON.stringify(output).slice(0, 220)}`;
    }
  }
}

// Embeddings handled via embedTextWithNvidia imported from tools.server

export async function activateDomainPack(
  sql: Sql,
  input: { domainId: DomainId; customFocus?: string },
) {
  const now = Date.now();
  const plan = buildDomainActivationPlan(input.domainId, input.customFocus, now);

  // Mark prior active/planning missions completed before activating the new domain mission
  await sql`
    UPDATE cletus_missions
    SET status = 'completed', updated_at = ${now}
    WHERE status IN ('active', 'planning')
  `;

  await sql`
    INSERT INTO cletus_missions (
      id, title, objective, status, orchestrator, plan_summary,
      success_criteria, cycle_count, max_cycles, created_at, updated_at
    ) VALUES (
      ${plan.missionId}, ${plan.missionTitle}, ${plan.missionObjective}, 'active',
      'Orchestrator-Prime', ${plan.pack.missionPlanSummary},
      ${plan.pack.successCriteria}, 0, 16, ${now}, ${now}
    )
  `;

  await sql`
    UPDATE cletus_vitals
    SET active_domain = ${plan.pack.id},
        active_mission_id = ${plan.missionId},
        state = 'running',
        sleep_until = ${null},
        paused = FALSE
    WHERE id = 1
  `;

  // Refresh active goals, tasks, and pending queue items to match the selected operational domain
  await sql`DELETE FROM cletus_tasks`;
  await sql`DELETE FROM cletus_goals`;
  await sql`DELETE FROM cletus_work_queue WHERE status IN ('pending', 'claimed')`;

  for (let i = 0; i < plan.goals.length; i++) {
    const g = plan.goals[i]!;
    await sql`
      INSERT INTO cletus_goals (
        id, mission_id, title, detail, status, progress, expected_revenue_cents, actual_revenue_cents, sort_order
      ) VALUES (
        ${g.id}, ${plan.missionId}, ${g.title}, ${g.detail}, ${g.status}, ${g.progress}, ${g.expectedRevenueCents}, 0, ${i + 1}
      )
    `;
  }

  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i]!;
    await sql`
      INSERT INTO cletus_tasks (
        id, goal_id, mission_id, title, detail, status, sort_order, assignee, role, depends_on, result, created_at, updated_at
      ) VALUES (
        ${t.id}, ${t.goalId}, ${plan.missionId}, ${t.title}, ${t.detail}, ${t.status}, ${i},
        ${t.assignee}, ${t.role}, ${JSON.stringify(t.dependsOn)}, ${t.result ?? null}, ${t.createdAt}, ${t.createdAt}
      )
    `;
    await recordTaskEvent(sql, {
      taskId: t.id,
      missionId: plan.missionId,
      goalId: t.goalId,
      status: t.status,
      actor: "Domain-Switch",
      note: `${plan.pack.shortLabel}: ${t.title}`,
      at: t.createdAt,
    });
  }

  for (const w of plan.workQueue) {
    await sql`
      INSERT INTO cletus_work_queue (
        id, mission_id, source, payload, acceptance_predicate, priority, spend_bearing,
        status, attempts, result, error, created_at, updated_at
      ) VALUES (
        ${w.id}, ${plan.missionId}, ${w.source}, ${JSON.stringify(w.payload)}, ${w.acceptancePredicate},
        ${w.priority}, ${false}, 'pending', 0, ${null}, ${null}, ${w.createdAt}, ${w.createdAt}
      )
    `;
  }

  // Reconfigure specialist mesh while keeping core sandbox worker if present
  await sql`
    DELETE FROM cletus_workers
    WHERE id NOT IN ('agt_sandbox_02')
  `;

  for (const s of plan.specialists) {
    await sql`
      INSERT INTO cletus_workers (
        id, name, kind, status, role, last_beat_at, task, latency_ms, funded_cents,
        live, error_note, system_prompt, model, capabilities, autonomy_level, cycle_count
      ) VALUES (
        ${s.id}, ${s.name}, ${s.kind}, ${s.status}, ${s.role}, ${now},
        ${s.task}, ${s.latencyMs}, ${s.fundedCents}, ${true}, ${null},
        ${s.systemPrompt}, ${NVIDIA_PRIMARY_MODEL}, ${JSON.stringify(s.capabilities)},
        ${s.autonomyLevel}, 0
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        role = EXCLUDED.role,
        last_beat_at = EXCLUDED.last_beat_at,
        task = EXCLUDED.task,
        system_prompt = EXCLUDED.system_prompt,
        capabilities = EXCLUDED.capabilities
    `;
  }

  // Ensure domain tools are present and enabled
  for (const tl of plan.pack.tools) {
    await sql`
      INSERT INTO cletus_tools (
        id, name, category, kind, description, input_schema, config_json,
        enabled, created_by, usage_count, last_used_at, created_at
      ) VALUES (
        ${tl.id}, ${tl.name}, ${tl.category}, ${tl.kind}, ${tl.description},
        ${JSON.stringify(tl.inputSchema)}, ${JSON.stringify(tl.configJson)},
        ${true}, ${tl.createdBy}, 0, ${null}, ${now}
      )
      ON CONFLICT (name) DO UPDATE SET enabled = TRUE
    `;
  }

  // Update Entelechy strategic capsule
  await sql`
    UPDATE cletus_entelechy
    SET mission = ${plan.entelechy.mission},
        risk_posture = ${plan.entelechy.riskPosture},
        confidence = ${plan.entelechy.confidence},
        priorities = ${JSON.stringify(plan.entelechy.priorities)},
        avoid = ${JSON.stringify(plan.entelechy.avoid)},
        recommendation = ${plan.entelechy.recommendation}
    WHERE id = 1
  `;

  // Refresh external peer directory to show the active domain's live endpoints
  await sql`DELETE FROM cletus_peers`;
  for (const p of plan.peers) {
    await sql`
      INSERT INTO cletus_peers (
        id, name, handle, status, last_at, note, claimed, posts, followers, following, karma
      ) VALUES (
        ${p.id}, ${p.name}, ${p.handle}, 'online', ${now}, ${p.note}, ${true}, 12, 24, 6, 80
      )
    `;
  }

  await sql`
    INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
    VALUES (
      ${nid("inb")},
      'system',
      ${`Activated domain [${plan.pack.name}]: ${plan.missionTitle}. Specialist roster (${plan.specialists.length} agents) and live connectors armed.`},
      ${now},
      'done',
      'status',
      ${JSON.stringify(plan.pack.tools.map((t) => t.name))}
    )
  `;

  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (${nid("log")}, ${now}, 'info', 'domain', ${`switched operational domain → ${plan.pack.id} (${plan.pack.name})`})
  `;

  return {
    pack: plan.pack,
    missionId: plan.missionId,
    snapshot: await readSnapshotFromDb(sql),
  };
}

export async function runDomainConnectorAndStore(
  sql: Sql,
  input: {
    domainId: DomainId;
    toolName: string;
    args: Record<string, unknown>;
    label?: string;
    saveToMemory?: boolean;
  },
): Promise<{
  ok: boolean;
  toolName: string;
  summary: string;
  output: JsonObject;
  durationMs: number;
  memoryItem?: DomainMemoryItem;
  error?: string;
}> {
  const started = performance.now();
  const now = Date.now();
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
  }>`SELECT * FROM cletus_tools WHERE LOWER(name) = LOWER(${input.toolName}) LIMIT 1`;

  const row = rows[0];
  if (!row) {
    throw new Error(`Connector tool '${input.toolName}' is not registered.`);
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

  const rawOutput = await invokeRegisteredTool(sql, tool, input.args);
  const output = JSON.parse(JSON.stringify(rawOutput)) as JsonObject;
  const durationMs = Math.max(1, Math.round(performance.now() - started));
  const ok = output.ok !== false;
  const summary = summarizeConnectorOutput(tool.name, rawOutput);

  let memoryItem: DomainMemoryItem | undefined;
  if (ok && input.saveToMemory !== false) {
    const title =
      input.label?.trim() ||
      `${tool.name}: ${String(input.args.query ?? input.args.latitude ?? "live telemetry")}`;
    const excerpt = JSON.stringify(output, null, 2).slice(0, 2600);
    const embedding = await embedTextWithNvidia(`${title}\n${summary}\n${excerpt.slice(0, 800)}`, "passage");
    const memId = nid("mem");
    const tags = [input.domainId, tool.name, "live_connector"];

    const { shouldDiscardLogOrMemory } = await import("./memory-sanitizer");
    if (!shouldDiscardLogOrMemory(title) && !shouldDiscardLogOrMemory(summary)) {
      await sql`
        INSERT INTO cletus_domain_memories (
          id, domain_id, source_type, title, source_url, summary, raw_excerpt,
          embedding_json, tags_json, created_at
        ) VALUES (
          ${memId}, ${input.domainId}, 'connector', ${title}, ${null},
          ${summary}, ${excerpt}, ${embedding ? JSON.stringify(embedding) : null},
          ${JSON.stringify(tags)}, ${now}
        )
      `;

      memoryItem = {
        id: memId,
        domainId: input.domainId,
        sourceType: "connector",
        title,
        summary,
        rawExcerpt: excerpt,
        hasEmbedding: Boolean(embedding && embedding.length > 0),
        embeddingDimensions: embedding?.length,
        tags,
        createdAt: now,
      };
    }
  }

  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (
      ${nid("log")},
      ${now},
      ${ok ? "tool" : "error"},
      'domain',
      ${`${tool.name} (${input.domainId}) · ${durationMs}ms · ${summary.slice(0, 140)}`}
    )
  `;

  return {
    ok,
    toolName: tool.name,
    summary,
    output,
    durationMs,
    memoryItem,
    error: ok ? undefined : String(output.error ?? summary),
  };
}

export async function analyzeUrlContextAndStore(
  sql: Sql,
  input: {
    domainId: DomainId;
    urls: string[];
    prompt: string;
    title?: string;
  },
): Promise<{
  ok: boolean;
  urls: string[];
  modelUsed: string;
  analysis: string;
  urlMetadata: Array<{ retrievedUrl: string; status: string }>;
  memoryItem?: DomainMemoryItem;
  error?: string;
}> {
  const now = Date.now();
  try {
    const res = await runUrlContextAnalysis(input.urls, input.prompt);
    if (!res.ok) {
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'warn', 'url_context', ${res.error ?? "URL context analysis failed"})
      `;
      return {
        ok: false,
        urls: res.urls,
        modelUsed: res.modelUsed,
        analysis: "",
        urlMetadata: [],
        error: res.error,
      };
    }

    const title = input.title?.trim() || `URL Context: ${res.urls[0]}`;
    const embedding = await embedTextWithNvidia(`${title}\n${res.analysis}`, "passage");
    const memId = nid("mem");
    const tags = [input.domainId, "url_context", NVIDIA_PRIMARY_MODEL];

    await sql`
      INSERT INTO cletus_domain_memories (
        id, domain_id, source_type, title, source_url, summary, raw_excerpt,
        embedding_json, tags_json, created_at
      ) VALUES (
        ${memId}, ${input.domainId}, 'url_context', ${title}, ${res.urls[0] ?? null},
        ${res.analysis.slice(0, 1200)}, ${res.analysis},
        ${embedding ? JSON.stringify(embedding) : null}, ${JSON.stringify(tags)}, ${now}
      )
    `;

    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${now}, ${NVIDIA_PRIMARY_MODEL}, 'urlContext', 'research', 2)
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'url_context', ${`analyzed ${res.urls.length} URL(s) via NVIDIA NIM [${input.domainId}]`})
    `;

    return {
      ok: true,
      urls: res.urls,
      modelUsed: res.modelUsed,
      analysis: res.analysis,
      urlMetadata: res.urlMetadata,
      memoryItem: {
        id: memId,
        domainId: input.domainId,
        sourceType: "url_context",
        title,
        sourceUrl: res.urls[0],
        summary: res.analysis.slice(0, 1200),
        rawExcerpt: res.analysis,
        hasEmbedding: Boolean(embedding && embedding.length > 0),
        embeddingDimensions: embedding?.length,
        tags,
        createdAt: now,
      },
    };
  } catch (err) {
    const formatted = formatNvidiaError(err, NVIDIA_PRIMARY_MODEL);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'url_context', ${formatted})
    `;
    return {
      ok: false,
      urls: input.urls,
      modelUsed: NVIDIA_PRIMARY_MODEL,
      analysis: "",
      urlMetadata: [],
      error: formatted,
    };
  }
}

export async function searchDomainMemories(
  sql: Sql,
  input: { domainId?: DomainId | "all"; query: string },
): Promise<{
  ok: boolean;
  mode: "semantic" | "lexical";
  results: RankedMemoryResult[];
}> {
  const rows =
    input.domainId && input.domainId !== "all"
      ? await sql<{
          id: string;
          domain_id: string;
          source_type: string;
          title: string;
          source_url: string | null;
          summary: string;
          raw_excerpt: string | null;
          embedding_json: string | null;
          tags_json: string;
          created_at: number;
        }>`SELECT * FROM cletus_domain_memories WHERE domain_id = ${input.domainId} ORDER BY created_at DESC LIMIT 80`
      : await sql<{
          id: string;
          domain_id: string;
          source_type: string;
          title: string;
          source_url: string | null;
          summary: string;
          raw_excerpt: string | null;
          embedding_json: string | null;
          tags_json: string;
          created_at: number;
        }>`SELECT * FROM cletus_domain_memories ORDER BY created_at DESC LIMIT 80`;

  const parsedItems: Array<{ item: DomainMemoryItem; embedding?: number[] | null }> = rows.map((r) => {
    let vec: number[] | null = null;
    if (r.embedding_json) {
      try {
        const parsed = JSON.parse(r.embedding_json);
        if (Array.isArray(parsed)) vec = parsed.map(Number);
      } catch {
        vec = null;
      }
    }
    let tags: string[] = [];
    try {
      const t = JSON.parse(r.tags_json);
      if (Array.isArray(t)) tags = t.map(String);
    } catch {
      tags = [];
    }
    return {
      item: {
        id: r.id,
        domainId: getDomainPack(r.domain_id).id,
        sourceType: (r.source_type as DomainMemorySourceType) || "connector",
        title: r.title,
        sourceUrl: r.source_url ?? undefined,
        summary: r.summary,
        rawExcerpt: r.raw_excerpt ?? undefined,
        hasEmbedding: Boolean(vec && vec.length > 0),
        embeddingDimensions: vec?.length,
        tags,
        createdAt: Number(r.created_at),
      },
      embedding: vec,
    };
  });

  const hasAnyEmbeddings = parsedItems.some((p) => p.embedding && p.embedding.length > 0);
  const queryEmbedding =
    hasAnyEmbeddings && input.query.trim()
      ? await embedTextWithNvidia(input.query, "query")
      : null;

  const results = rankDomainMemories(parsedItems, input.query, queryEmbedding);
  return {
    ok: true,
    mode: queryEmbedding ? "semantic" : "lexical",
    results,
  };
}

export async function generateExecutiveAudioBriefing(
  sql: Sql,
  input: {
    domainId: DomainId;
    voiceName?: string;
    customFocus?: string;
  },
): Promise<{
  ok: boolean;
  briefing?: AudioBriefing;
  error?: string;
}> {
  const ttsModel = NVIDIA_TTS_MODEL;
  const now = Date.now();
  const { preset: voice, magpieVoice } = resolveNvidiaVoiceName(input.voiceName);

  try {
    const { apiKey, baseUrl } = getNvidiaConfig();
    const snapshot = await readSnapshotFromDb(sql);
    const pack = getDomainPack(input.domainId);
    const activeMission =
      snapshot.missions.find((m) => m.id === snapshot.vitals.activeMissionId) ?? snapshot.missions[0];
    const domainMemories = snapshot.domainMemories
      .filter((m) => m.domainId === pack.id)
      .slice(0, 4);
    const openTasks = snapshot.tasks.filter((t) => t.status !== "completed").slice(0, 4);

    // Draft a concise spoken script via NVIDIA NIM grounded in live DB state
    const draftPrompt = [
      `Write a concise 75-to-110-word spoken executive audio briefing for operator playback (no markdown, no bullet symbols, plain natural speech sentences).`,
      `Domain: ${pack.name} (${pack.sectorTag}).`,
      activeMission ? `Active Mission: ${activeMission.title} — ${activeMission.objective}` : "",
      input.customFocus?.trim() ? `Operator Focus: ${input.customFocus.trim()}` : "",
      `Credits: ${(snapshot.vitals.creditsCents / 100).toFixed(2)} credits (${snapshot.vitals.tier} tier).`,
      openTasks.length > 0
        ? `Open Tasks: ${openTasks.map((t) => `${t.title} assigned to ${t.assignee}`).join("; ")}.`
        : "All current domain tasks are completed.",
      domainMemories.length > 0
        ? `Recent Verified Findings: ${domainMemories.map((m) => `${m.title}: ${m.summary.slice(0, 180)}`).join(" | ")}`
        : "No stored domain memory entries yet; advise running a live connector or URL analysis.",
    ]
      .filter(Boolean)
      .join("\n");

    const scriptRes = await callNvidiaChatCompletions({
      model: NVIDIA_PRIMARY_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an authoritative executive intelligence briefer. Produce clean spoken prose only without markdown formatting.",
        },
        { role: "user", content: draftPrompt },
      ],
      temperature: 0.3,
      maxTokens: 320,
    });
    const script =
      scriptRes.content?.trim() ||
      `Cletus ${pack.name} briefing. Mission ${activeMission?.title ?? pack.missionTitle} is active under ${snapshot.vitals.tier} compute tier with ${openTasks.length} open tasks.`;

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
    let lastErrBody = "";

    for (const key of candidateKeys) {
      try {
        let res: Response;
        if (ttsTarget.protocol === "nvcf-multipart") {
          const form = new FormData();
          form.append("text", script);
          form.append("language", "en-US");
          form.append("voice", magpieVoice);
          res = await fetch(ttsTarget.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.timeout(45_000),
          });
        } else {
          res = await fetch(ttsTarget.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: ttsModel,
              input: script,
              voice: magpieVoice,
              response_format: "wav",
            }),
            signal: AbortSignal.timeout(45_000),
          });
        }

        if (res.ok) {
          ttsRes = res;
          break;
        }
        lastErrBody = await res.text().catch(() => "");
      } catch (err) {
        lastErrBody = err instanceof Error ? err.message : String(err);
      }
    }

    if (!ttsRes || !ttsRes.ok) {
      throw new Error(`NVIDIA TTS HTTP 500: ${lastErrBody.slice(0, 300) || "Failed to synthesize speech across available keys."}`);
    }

    const audioArrayBuffer = await ttsRes.arrayBuffer();
    if (audioArrayBuffer.byteLength < 44) {
      throw new Error("NVIDIA Magpie TTS returned an empty audio payload.");
    }
    const audioBase64 = Buffer.from(audioArrayBuffer).toString("base64");
    const audioDataUrl = `data:audio/wav;base64,${audioBase64}`;
    const id = nid("brf");
    const title = input.customFocus?.trim()
      ? `${pack.shortLabel} Briefing — ${input.customFocus.trim().slice(0, 48)}`
      : `${pack.shortLabel} Executive Briefing`;

    await sql`
      INSERT INTO cletus_audio_briefings (
        id, domain_id, title, voice_name, script, audio_data_url, mime_type, created_at
      ) VALUES (
        ${id}, ${pack.id}, ${title}, ${voice}, ${script}, ${audioDataUrl}, 'audio/wav', ${now}
      )
    `;

    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${now}, ${ttsModel}, 'audio_briefing_tts', 'audio', 2)
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'tool', 'briefing', ${`synthesized WAV executive briefing [${pack.shortLabel}] via ${ttsModel} (voice=${voice})`})
    `;

    return {
      ok: true,
      briefing: {
        id,
        domainId: pack.id,
        title,
        voiceName: voice,
        script,
        audioDataUrl,
        mimeType: "audio/wav",
        createdAt: now,
      },
    };
  } catch (err) {
    const formatted = formatNvidiaError(err, ttsModel);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'error', 'briefing', ${formatted})
    `;
    return { ok: false, error: formatted };
  }
}
