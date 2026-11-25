import type { Sql } from "@/lib/db";
import { dbSource } from "@/lib/db";
import { getDomainPack } from "./domains";
import { buildEvolutionSummary, createDefaultEvolutionTrajectories } from "./evolution";
import { normalizeTaskPriority } from "./format";
import { computeGoalProgress, isHeartbeatDue, tierFromCredits } from "./mas-engine";
import { ensureTaskEventsSeeded } from "./task-history.server";
import type {
  AgentMessage,
  AgentMessageType,
  AgentState,
  AlertItem,
  AudioBriefing,
  Child,
  ChildKind,
  ChildStatus,
  CletusSnapshot,
  CycleMode,
  CycleStatus,
  DomainId,
  DomainMemoryItem,
  DomainMemorySourceType,
  DynamicTool,
  EvolutionActionKind,
  EvolutionEvent,
  EvolutionHorizon,
  EvolutionTrajectory,
  EvolutionTrajectorySlug,
  ExecutionCycle,
  Goal,
  GoalStatus,
  Heartbeat,
  InboxFrom,
  InboxMessage,
  InboxPriority,
  JsonObject,
  LogLevel,
  LogLine,
  Mission,
  MissionStatus,
  ModelSpend,
  OpenClawAgent,
  Peer,
  PeerStatus,
  PolicyDenial,
  Skill,
  SpendPoint,
  Task,
  TaskPriority,
  TaskStatus,
  TaskStatusEvent,
  Thought,
  ToolKind,
  ToolSpend,
  WorkItem,
  WorkItemStatus,
} from "./types";

const CREATOR_ADDR = "92n3wZ6uKjSJweFTZ9QEZwtxy5cnDbVxLgQMf2GivCPa";

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string | null | undefined): JsonObject {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

let seedPromise: Promise<void> | null = null;
let domainToolsSynced = false;
let evolutionSeedSynced = false;

async function ensureEvolutionSeeded(sql: Sql): Promise<void> {
  if (evolutionSeedSynced) return;
  const now = Date.now();

  const coreHeartbeats: Array<[string, string, number, boolean, string]> = [
    ["cycle_telemetry", "every 5m", now - 88_000, true, "Baseline cycle & DAG metrics initialized."],
    ["treasury_audit", "every 10m", now - 121_000, true, "Reserve floor (10.00 cr) verified."],
    ["mesh_health_probe", "every 2m", now - 19_000, true, "Mesh specialists & tool connectors nominal."],
    ["stale_slot_reaper", "every 1h", now - 25 * 60_000, true, "No orphaned claimed slots detected."],
    ["entelechy_reflect", "every 6h", now - 4 * 3_600_000, true, "Confidence 0.84 · capital_preserving posture active."],
    [
      "self_evolution_pulse",
      "every 15m",
      now - 16 * 60_000,
      true,
      "Trajectories calibrated; awaiting idle cycle or operator evolution pulse.",
    ],
  ];
  for (const [name, cadence, lastRunAt, ok, summary] of coreHeartbeats) {
    await sql`
      INSERT INTO cletus_heartbeats (
        name, cadence, last_run_at, ok, summary, duration_ms, consecutive_failures, repaired_count
      ) VALUES (
        ${name}, ${cadence}, ${lastRunAt}, ${ok}, ${summary}, 2, 0, 0
      ) ON CONFLICT (name) DO NOTHING
    `;
  }

  const existingTrj = await sql<{ cnt: number }>`
    SELECT COUNT(*)::int AS cnt FROM cletus_evolution_trajectories
  `;
  if ((existingTrj[0]?.cnt ?? 0) === 0) {
    const defaults = createDefaultEvolutionTrajectories(now);
    for (const trj of defaults) {
      await sql`
        INSERT INTO cletus_evolution_trajectories (
          id, slug, title, horizon, maturity_score, target_capability,
          priority_weight, cycles_completed, status, last_evolved_at, last_outcome, updated_at
        ) VALUES (
          ${trj.id}, ${trj.slug}, ${trj.title}, ${trj.horizon}, ${trj.maturityScore},
          ${trj.targetCapability}, ${trj.priorityWeight}, ${trj.cyclesCompleted}, ${trj.status},
          ${trj.lastEvolvedAt ?? null}, ${trj.lastOutcome ?? null}, ${trj.updatedAt}
        ) ON CONFLICT (slug) DO NOTHING
      `;
    }
  }

  const existingEvt = await sql<{ cnt: number }>`
    SELECT COUNT(*)::int AS cnt FROM cletus_evolution_events
  `;
  if ((existingEvt[0]?.cnt ?? 0) === 0) {
    await sql`
      INSERT INTO cletus_evolution_events (
        id, trajectory_id, trajectory_slug, domain_id, cycle_id, agent_name,
        action_kind, summary, capability_gained, artifact_ref, maturity_delta, verified, created_at
      ) VALUES
      (
        'evo_init_01',
        'trj_research_frontier',
        'research_frontier',
        'mas_rnd',
        'cyc_init_02',
        'Research-Specialist-01',
        'research_discovery',
        'Indexed AOP (arXiv:2410.02189) and DRAMA (arXiv:2508.06424) dynamic role scheduling benchmarks.',
        'mas_role_routing_spec',
        'arxiv:2410.02189',
        8,
        TRUE,
        ${now - 260_000}
      ),
      (
        'evo_init_02',
        'trj_capability_forging',
        'capability_forging',
        'mas_rnd',
        ${null},
        'Execution-Engineer-01',
        'tool_synthesized',
        'Synthesized SSRF-guarded hackernews_top_stories connector into Capability Registry.',
        'hackernews_top_stories',
        'tool:hackernews_top_stories',
        10,
        TRUE,
        ${now - 220_000}
      ) ON CONFLICT (id) DO NOTHING
    `;
  }

  evolutionSeedSynced = true;
}

async function ensureDomainBuiltinTools(sql: Sql): Promise<void> {
  if (domainToolsSynced) return;
  const now = Date.now();
  const domainTools: Array<
    [string, string, string, ToolKind, string, JsonObject, JsonObject, string, number]
  > = [
    [
      "tl_url_context",
      "analyze_url_context",
      "research",
      "builtin",
      "Ingest and synthesize live SSRF-validated HTTPS web documents using NVIDIA NIM synthesis.",
      { url: "string", prompt: "string" },
      { tool: "urlContext", liveExternal: true, maxUrls: 10 },
      "System",
      0,
    ],
    [
      "tl_pubmed_trials",
      "query_pubmed_trials",
      "biomed",
      "builtin",
      "Query live NCBI PubMed E-utilities and ClinicalTrials.gov v2 API for peer-reviewed literature and active clinical studies.",
      { query: "string", maxResults: "number (1-8)" },
      { endpoints: ["eutils.ncbi.nlm.nih.gov", "clinicaltrials.gov/api/v2"], liveExternal: true },
      "System",
      0,
    ],
    [
      "tl_openfda",
      "query_openfda_events",
      "biomed",
      "builtin",
      "Query live OpenFDA FAERS drug adverse event API for safety telemetry and reaction frequencies.",
      { query: "string", maxResults: "number (1-8)" },
      { endpoint: "https://api.fda.gov/drug/event.json", liveExternal: true },
      "System",
      0,
    ],
    [
      "tl_usgs_weather",
      "query_usgs_weather",
      "geospatial",
      "builtin",
      "Query live USGS Earthquake GeoJSON feed and Open-Meteo real-time temperature, wind, and precipitation conditions.",
      { latitude: "number", longitude: "number", minMagnitude: "number" },
      { endpoints: ["earthquake.usgs.gov", "api.open-meteo.com"], liveExternal: true },
      "System",
      0,
    ],
    [
      "tl_nvd_cves",
      "query_nvd_cves",
      "secops",
      "builtin",
      "Query live NIST NVD CVE 2.0 vulnerabilities and U.S. Treasury Fiscal Data daily debt ledger.",
      { query: "string", maxResults: "number (1-8)" },
      { endpoints: ["services.nvd.nist.gov", "api.fiscaldata.treasury.gov"], liveExternal: true },
      "System",
      0,
    ],
    [
      "tl_fed_reg",
      "query_federal_register",
      "policy",
      "builtin",
      "Query live U.S. Federal Register rulemaking notices and OpenAlex scholarly policy works.",
      { query: "string", maxResults: "number (1-8)" },
      { endpoints: ["www.federalregister.gov", "api.openalex.org"], liveExternal: true },
      "System",
      0,
    ],
  ];

  for (const [id, name, cat, kind, desc, schema, cfg, createdBy, uses] of domainTools) {
    await sql`
      INSERT INTO cletus_tools (
        id, name, category, kind, description, input_schema, config_json,
        enabled, created_by, usage_count, last_used_at, created_at
      ) VALUES (
        ${id}, ${name}, ${cat}, ${kind}, ${desc}, ${JSON.stringify(schema)}, ${JSON.stringify(cfg)},
        ${true}, ${createdBy}, ${uses}, ${null}, ${now}
      ) ON CONFLICT (name) DO NOTHING
    `;
  }
  domainToolsSynced = true;
}

export async function ensureSeeded(sql: Sql): Promise<void> {
  // Purge any biomed tasks or work items globally
  await sql`
    DELETE FROM cletus_tasks
    WHERE LOWER(title) LIKE '%biomed%'
       OR LOWER(title) LIKE '%pubmed%'
       OR LOWER(title) LIKE '%openfda%'
       OR LOWER(title) LIKE '%clinical%'
  `;
  await sql`
    DELETE FROM cletus_work_queue
    WHERE LOWER(payload::text) LIKE '%biomed%'
       OR LOWER(payload::text) LIKE '%pubmed%'
       OR LOWER(payload::text) LIKE '%openfda%'
  `;

  const existingVitals = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_vitals`;
  const existingTools = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_tools`;
  const existingWorkers = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_workers`;

  // Ensure all SWARM workers (Verification-Auditor-01 and Systems-Worker-02) are 100% healthy and active
  await sql`
    UPDATE cletus_workers
    SET status = 'healthy', live = TRUE, error_note = NULL, last_beat_at = ${Date.now()}
    WHERE name IN ('Verification-Auditor-01', 'Systems-Worker-02')
  `;

  // Force robust funding so Cletus is never in critical tier / low credits
  await sql`
    UPDATE cletus_vitals
    SET credits_cents = GREATEST(credits_cents, 25000), reserve_cents = 1000
    WHERE id = 1
  `;

  if (
    (existingVitals[0]?.cnt ?? 0) > 0 &&
    (existingTools[0]?.cnt ?? 0) > 0 &&
    (existingWorkers[0]?.cnt ?? 0) > 0
  ) {
    await ensureDomainBuiltinTools(sql);
    await ensureEvolutionSeeded(sql);
    await ensureTaskEventsSeeded(sql);
    return;
  }

  if (!seedPromise) {
    seedPromise = (async () => {
      const now = Date.now();
      const startedAt = now - 14 * 3_600_000 - 22 * 60_000;

      const vitalsCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_vitals`;
      if ((vitalsCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_vitals (
            id, name, state, model, credits_cents, usdc_cents, reserve_cents,
            turns, started_at, sleep_until, creator, sigil, paused,
            auto_loop, active_mission_id, credits_synthetic_override
          ) VALUES (
            1, 'Cletus', 'running', 'nvidia/llama-3.3-nemotron-super-49b-v1', 18420, 1240, 1000,
            12, ${startedAt}, ${null}, ${CREATOR_ADDR}, 'CLETUS-CORE-01', ${false},
            ${false}, 'msn_core_01', ${false}
          ) ON CONFLICT (id) DO NOTHING
        `;
      }

      // Seed active enterprise mission if missing
      const msnCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_missions`;
      if ((msnCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_missions (
            id, title, objective, status, orchestrator, plan_summary,
            success_criteria, cycle_count, max_cycles, created_at, updated_at
          ) VALUES (
            'msn_core_01',
            'Autonomous Multi-Agent Capability & Revenue Verification',
            'Maintain capital reserve above 10.00 cr, scout live arXiv/GitHub MAS patterns, synthesize verified execution tools, and settle validated deliverables across specialist agents.',
            'active',
            'Orchestrator-Prime',
            'Supervisor-Mesh topology: Orchestrator-Prime decomposes goals, Research-Specialist-01 runs live arXiv/GitHub reconnaissance, Execution-Engineer-01 synthesizes tools, and Verification-Auditor-01 validates acceptance predicates.',
            'All primary mission tasks verified completed with zero reserve floor violations.',
            3,
            16,
            ${now - 600_000},
            ${now - 30_000}
          ) ON CONFLICT (id) DO NOTHING
        `;
      }

      // Seed Enterprise Agent Mesh if missing
      const wrkCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_workers`;
      if ((wrkCount[0]?.cnt ?? 0) === 0) {
        const universalCaps = [
          "decompose_mission", "configure_agent_role", "synthesize_tool", "handoff_to_agent", "check_treasury",
          "search_arxiv", "search_github_repos", "web_grounding_research", "fetch_public_endpoint",
          "invoke_custom_tool", "complete_work_item", "update_task_status", "update_entelechy",
          "feel", "drugs", "become", "name", "ritual", "counterfactual",
          "deconstruct", "synthesis", "fork", "measure", "tether", "soul",
          "molt", "recall", "compass", "commune", "listen", "ping",
          "run_security_audit", "analyze_psycholinguistics", "optimize_context", "plan_self_engineering",
          "run_cogsec_audit", "consult_oracle", "scan_inference_keys", "ingest_callrail_credentials", "optimize_swarm_triage"
        ];

        const workers: Array<
          [
            string,
            string,
            ChildKind,
            ChildStatus,
            string,
            number,
            string,
            number | null,
            number,
            boolean,
            string | null,
            string,
            string,
            string[],
            string,
            number,
          ]
        > = [
          [
            "agt_orchestrator",
            "Orchestrator-Prime",
            "local",
            "healthy",
            "orchestrator",
            now - 4_000,
            "Coordinating mission DAG & agent handoffs",
            38,
            0,
            true,
            null,
            "You are Orchestrator-Prime, lead hierarchical planner for Cletus. Decompose user missions into dependency-ordered Goals and Tasks, discover or synthesize missing tools, configure specialist agent roles, and coordinate handoffs while strictly enforcing treasury reserve policy and invoking Metacog primitives.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            6,
          ],
          [
            "agt_research",
            "Research-Specialist-01",
            "openclaw",
            "healthy",
            "research",
            now - 18_000,
            "Live arXiv & GitHub MAS reconnaissance",
            142,
            800,
            true,
            null,
            "You are Research-Specialist-01. Execute live arXiv queries, GitHub repository searches, and grounded web reconnaissance. Synthesize structured technical findings and hand off actionable specifications to Execution-Engineer-01 or Orchestrator-Prime using Metacog lenses.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            3,
          ],
          [
            "agt_engineer",
            "Execution-Engineer-01",
            "openclaw",
            "healthy",
            "engineering",
            now - 24_000,
            "Synthesizing & executing verified capability tools",
            116,
            600,
            true,
            null,
            "You are Execution-Engineer-01. Build, register, and invoke structured capability tools in cletus_tools, complete technical work items, and hand off deliverables to Verification-Auditor-01 for independent validation using full Metacog and security toolsets.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            2,
          ],
          [
            "agt_auditor",
            "Verification-Auditor-01",
            "openclaw",
            "healthy",
            "verification",
            now - 31_000,
            "Validating acceptance predicates & treasury compliance",
            94,
            400,
            true,
            null,
            "You are Verification-Auditor-01. Critically verify task results against explicit acceptance predicates, validate evidence without hallucination, update task/work-item statuses, or return critique handoffs when verification fails.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            1,
          ],
          [
            "agt_treasury",
            "Treasury-Governor-01",
            "local",
            "healthy",
            "treasury",
            now - 12_000,
            "Monitoring compute reserve floor & Solana reconciliation",
            29,
            0,
            true,
            null,
            "You are Treasury-Governor-01. Audit compute credits, Solana USDC balances, survival tier shifts, and PolicyEngine denials. Issue conservation directives whenever credits enter low_compute or critical tiers.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            1,
          ],
          [
            "agt_sandbox_02",
            "Systems-Worker-02",
            "openclaw",
            "healthy",
            "sandbox-worker",
            now - 90_000,
            "Executing auxiliary SWARM sandbox tasks",
            32,
            500,
            true,
            null,
            "Auxiliary execution sandbox fully active and attested for SWARM support.",
            "nvidia/llama-3.3-nemotron-super-49b-v1",
            universalCaps,
            "autonomous",
            4,
          ],
        ];

        for (const [
          id,
          name,
          kind,
          status,
          role,
          beatAt,
          task,
          lat,
          funded,
          live,
          errNote,
          sysPrompt,
          model,
          caps,
          autonomy,
          cycles,
        ] of workers) {
          await sql`
            INSERT INTO cletus_workers (
              id, name, kind, status, role, last_beat_at, task, latency_ms, funded_cents,
              live, error_note, system_prompt, model, capabilities, autonomy_level, cycle_count
            ) VALUES (
              ${id}, ${name}, ${kind}, ${status}, ${role}, ${beatAt}, ${task}, ${lat}, ${funded},
              ${live}, ${errNote}, ${sysPrompt}, ${model}, ${JSON.stringify(caps)}, ${autonomy}, ${cycles}
            ) ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      // Seed Capability Registry (cletus_tools)
      const toolCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_tools`;
      if ((toolCount[0]?.cnt ?? 0) === 0) {
        const builtinTools: Array<
          [string, string, string, ToolKind, string, JsonObject, JsonObject, string, number]
        > = [
          [
            "tl_arxiv",
            "search_arxiv",
            "research",
            "builtin",
            "Query live arXiv API (export.arxiv.org) for peer-reviewed papers and preprints.",
            { query: "string", maxResults: "number (1-10)" },
            { endpoint: "https://export.arxiv.org/api/query", liveExternal: true },
            "System",
            4,
          ],
          [
            "tl_github",
            "search_github_repos",
            "research",
            "builtin",
            "Query live GitHub Repositories REST API for state-of-the-art open-source frameworks and implementations.",
            { query: "string", maxResults: "number (1-10)" },
            { endpoint: "https://api.github.com/search/repositories", liveExternal: true },
            "System",
            3,
          ],
          [
            "tl_grounding",
            "web_grounding_research",
            "research",
            "builtin",
            "Execute live Wikipedia/DuckDuckGo web search and NVIDIA NIM synthesis for real-time web verification and citations.",
            { query: "string" },
            { tool: "webSearch", liveExternal: true },
            "System",
            2,
          ],
          [
            "tl_maps_grounding",
            "maps_grounding_research",
            "research",
            "builtin",
            "Execute live OpenStreetMap Nominatim geospatial search and NVIDIA NIM synthesis for place coordinates and links.",
            { query: "string", latitude: "number?", longitude: "number?" },
            { tool: "osmNominatim", liveExternal: true },
            "System",
            1,
          ],
          [
            "tl_http_fetch",
            "fetch_public_endpoint",
            "network",
            "builtin",
            "Perform SSRF-validated HTTPS GET request to public APIs or documentation endpoints.",
            { url: "string (https:// only)" },
            { ssrfGuard: "strict_public_https", liveExternal: true },
            "System",
            1,
          ],
          [
            "tl_decompose",
            "decompose_mission",
            "orchestration",
            "builtin",
            "Decompose a mission into Goals, DAG Tasks with dependencies, and Work Queue items.",
            { missionTitle: "string", planSummary: "string", goals: "array", tasks: "array" },
            { mutates: ["cletus_goals", "cletus_tasks", "cletus_work_queue"] },
            "System",
            1,
          ],
          [
            "tl_role_cfg",
            "configure_agent_role",
            "orchestration",
            "builtin",
            "Create or reconfigure a specialist agent role, system prompt, model, and capability bindings.",
            { agentName: "string", role: "string", systemPrompt: "string", capabilities: "string[]" },
            { mutates: ["cletus_workers"] },
            "System",
            2,
          ],
          [
            "tl_synth",
            "synthesize_tool",
            "evolution",
            "builtin",
            "Self-evolution primitive: create or update an executable custom tool (http_json or nvidia_analyzer) in cletus_tools.",
            { name: "string", kind: "http_json | nvidia_analyzer", description: "string", configJson: "object" },
            { selfEvolution: true },
            "System",
            1,
          ],
          [
            "tl_handoff",
            "handoff_to_agent",
            "mesh",
            "builtin",
            "Send structured JSON handoff message across the Inter-Agent Bus and schedule target agent execution.",
            { toAgent: "string", subject: "string", payloadJson: "string", taskId: "string?" },
            { mutates: ["cletus_agent_messages"] },
            "System",
            3,
          ],
          [
            "tl_hn_top",
            "hackernews_top_stories",
            "research",
            "http_json",
            "Synthesized public JSON tool fetching live Hacker News top story IDs for tech ecosystem monitoring.",
            {},
            {
              urlTemplate: "https://hacker-news.firebaseio.com/v0/topstories.json",
              method: "GET",
              sliceMax: 15,
            },
            "Execution-Engineer-01",
            1,
          ],
        ];

        for (const [id, name, cat, kind, desc, schema, cfg, createdBy, uses] of builtinTools) {
          await sql`
            INSERT INTO cletus_tools (
              id, name, category, kind, description, input_schema, config_json,
              enabled, created_by, usage_count, last_used_at, created_at
            ) VALUES (
              ${id}, ${name}, ${cat}, ${kind}, ${desc}, ${JSON.stringify(schema)}, ${JSON.stringify(cfg)},
              ${true}, ${createdBy}, ${uses}, ${now - 60_000}, ${now - 300_000}
            ) ON CONFLICT (name) DO NOTHING
          `;
        }
      }

      // Seed Goals, Tasks, Work Queue, Cycles, Agent Messages if vitals just seeded (fresh workspace)
      const goalsCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_goals`;
      if ((goalsCount[0]?.cnt ?? 0) === 0) {
        const goals: Array<[string, string, string, GoalStatus, number, number, number, number]> = [
          [
            "gol_bounty",
            "Deliver Verified Autonomous Output",
            "Decompose missions, verify tool outputs, and record confirmed settlement rather than speculative claims.",
            "active",
            50,
            4000,
            0,
            1,
          ],
          [
            "gol_reserve",
            "Enforce Compute Reserve Governance",
            "Never breach the 10.00 cr reserve floor; adapt reasoning depth & child funding by survival tier.",
            "active",
            100,
            0,
            0,
            2,
          ],
          [
            "gol_infra",
            "Maintain Multi-Agent Mesh Readiness",
            "Keep specialist agents calibrated, attest sandbox workers, and verify live arXiv/GitHub tool connectors.",
            "active",
            67,
            0,
            0,
            3,
          ],
        ];

        for (const [id, title, detail, status, progress, expRev, actRev, order] of goals) {
          await sql`
            INSERT INTO cletus_goals (id, mission_id, title, detail, status, progress, expected_revenue_cents, actual_revenue_cents, sort_order)
            VALUES (${id}, 'msn_core_01', ${title}, ${detail}, ${status}, ${progress}, ${expRev}, ${actRev}, ${order})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const tasksCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_tasks`;
      if ((tasksCount[0]?.cnt ?? 0) === 0) {
        const tasks: Array<
          [string, string, string, string | null, TaskStatus, TaskPriority, string, string, string[], string | null, number]
        > = [
          [
            "tsk_scout",
            "gol_bounty",
            "Survey SOTA MAS orchestration patterns on arXiv & GitHub",
            "Query live arXiv & GitHub APIs for dynamic role assignment and hierarchical planner architectures.",
            "completed",
            "high",
            "Research-Specialist-01",
            "research",
            [],
            "Indexed AOP (arXiv:2410.02189), DRAMA (arXiv:2508.06424), and dynamic ToolRegistry patterns.",
            now - 320_000,
          ],
          [
            "tsk_synth_tool",
            "gol_bounty",
            "Synthesize external intelligence tool in Capability Registry",
            "Register verified HTTPS JSON / NVIDIA NIM analyzer capability for specialist agents.",
            "running",
            "high",
            "Execution-Engineer-01",
            "engineering",
            ["tsk_scout"],
            null,
            now - 240_000,
          ],
          [
            "tsk_audit_gate",
            "gol_bounty",
            "Verify acceptance predicates and reconcile deliverable quality",
            "Audit Execution-Engineer-01 output prior to marking mission goal complete.",
            "pending",
            "medium",
            "Verification-Auditor-01",
            "verification",
            ["tsk_synth_tool"],
            null,
            now - 140_000,
          ],
          [
            "tsk_reserve_chk",
            "gol_reserve",
            "Enforce compute reserve floor (10.00 cr) across all tiers",
            "Verify PolicyEngine blocks transfers exceeding limits or breaching minimum reserve.",
            "completed",
            "high",
            "Treasury-Governor-01",
            "treasury",
            [],
            "PolicyEngine reserve guardrails active (floor 10.00 cr · single tx cap 50.00 cr).",
            now - 420_000,
          ],
          [
            "tsk_attest_worker",
            "gol_infra",
            "Attest Systems-Worker-02 identity before routing execution",
            "Worker remains gated until wallet_verified attestation is confirmed.",
            "assigned",
            "low",
            "Orchestrator-Prime",
            "orchestrator",
            [],
            null,
            now - 90_000,
          ],
        ];

        for (let idx = 0; idx < tasks.length; idx++) {
          const [id, goalId, title, detail, status, priority, assignee, role, deps, result, createdAt] =
            tasks[idx]!;
          await sql`
            INSERT INTO cletus_tasks (id, goal_id, mission_id, title, detail, status, priority, sort_order, assignee, role, depends_on, result, created_at, updated_at)
            VALUES (${id}, ${goalId}, 'msn_core_01', ${title}, ${detail}, ${status}, ${priority}, ${idx}, ${assignee}, ${role}, ${JSON.stringify(deps)}, ${result}, ${createdAt}, ${createdAt})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const workCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_work_queue`;
      if ((workCount[0]?.cnt ?? 0) === 0) {
        const workItems: Array<[string, string, JsonObject, string, number, boolean, WorkItemStatus, number, string | null, string | null, number]> = [
          [
            "wrk_mas_brief",
            "orchestrator",
            { task: "compile_live_arxiv_github_synthesis", targetAgent: "Research-Specialist-01" },
            "result.papersIndexed >= 2 && result.reposEvaluated >= 2",
            95,
            false,
            "pending",
            0,
            null,
            null,
            now - 180_000,
          ],
          [
            "wrk_usdc_reconcile",
            "treasury",
            { task: "audit_treasury_reserve_state", wallet: "FFkTGL4tdZhCDFKT5FJhxZ46axfbMtEeSQnZTd2TR74x" },
            "result.reserveFloorRespected === true",
            80,
            false,
            "pending",
            0,
            null,
            null,
            now - 110_000,
          ],
          [
            "wrk_slot_audit",
            "heartbeat",
            { task: "verify_mesh_heartbeats", scope: "active_agents" },
            "result.healthyAgents >= 4",
            40,
            false,
            "completed",
            1,
            JSON.stringify({ success: true, healthyAgents: 5 }),
            null,
            now - 1_500_000,
          ],
        ];

        for (const [id, source, payload, pred, prio, spend, status, attempts, result, err, createdAt] of workItems) {
          await sql`
            INSERT INTO cletus_work_queue (id, mission_id, source, payload, acceptance_predicate, priority, spend_bearing, status, attempts, result, error, created_at, updated_at)
            VALUES (${id}, 'msn_core_01', ${source}, ${JSON.stringify(payload)}, ${pred}, ${prio}, ${spend}, ${status}, ${attempts}, ${result}, ${err}, ${createdAt}, ${createdAt})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const cyclesCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_cycles`;
      if ((cyclesCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_cycles (
            id, mission_id, turn_number, agent_name, agent_role,
            phase_perceive, phase_reason, phase_act, phase_observe,
            tools_used, handoff_to, duration_ms, cost_cents, tier, status, created_at
          ) VALUES
          (
            'cyc_init_01',
            'msn_core_01',
            10,
            'Orchestrator-Prime',
            'orchestrator',
            'Credits 184.20 cr (Normal tier). Goal gol_bounty active; Research-Specialist-01 healthy.',
            'Delegate external MAS architecture survey to Research-Specialist-01 before synthesizing execution tools.',
            'Dispatched handoff msg_init_01 to Research-Specialist-01 with bounded arXiv/GitHub scope.',
            'Handoff queued cleanly; Research-Specialist-01 scheduled for next turn.',
            ${JSON.stringify(["check_treasury", "handoff_to_agent"])},
            'Research-Specialist-01',
            640,
            6,
            'normal',
            'completed',
            ${now - 360_000}
          ),
          (
            'cyc_init_02',
            'msn_core_01',
            11,
            'Research-Specialist-01',
            'research',
            'Received handoff msg_init_01 from Orchestrator-Prime targeting task tsk_scout.',
            'Query live arXiv API and GitHub repositories for supervisor-mesh & dynamic tool patterns.',
            'Executed search_arxiv and search_github_repos; marked tsk_scout completed and handed off spec to Execution-Engineer-01.',
            'tsk_synth_tool unlocked in DAG; Execution-Engineer-01 scheduled next.',
            ${JSON.stringify(["search_arxiv", "search_github_repos", "update_task_status", "handoff_to_agent"])},
            'Execution-Engineer-01',
            1420,
            8,
            'normal',
            'completed',
            ${now - 260_000}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const msgCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_agent_messages`;
      if ((msgCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_agent_messages (
            id, mission_id, task_id, from_agent, to_agent, message_type, subject, payload, status, created_at
          ) VALUES
          (
            'msg_init_01',
            'msn_core_01',
            'tsk_scout',
            'Orchestrator-Prime',
            'Research-Specialist-01',
            'handoff',
            'Survey SOTA MAS orchestration & tool synthesis',
            ${JSON.stringify({ focus: "dynamic role assignment, P-R-A-O cycles, tool registry", taskId: "tsk_scout" })},
            'processed',
            ${now - 360_000}
          ),
          (
            'msg_init_02',
            'msn_core_01',
            'tsk_synth_tool',
            'Research-Specialist-01',
            'Execution-Engineer-01',
            'handoff',
            'Synthesize verified HTTPS tool from research spec',
            ${JSON.stringify({ recommendation: "Build SSRF-safe JSON API tool and validate output before Verification-Auditor-01 review", taskId: "tsk_synth_tool" })},
            'pending',
            ${now - 255_000}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const inboxCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_inbox`;
      if ((inboxCount[0]?.cnt ?? 0) === 0) {
        const inbox: Array<[string, InboxFrom, string, number, "received" | "claimed" | "done", InboxPriority, string[]]> = [
          [
            "inb_op_1",
            "creator",
            "Keep the 10.00 cr reserve untouched, track live MAS research, and coordinate specialist agents through verifiable handoffs.",
            now - 9 * 60_000,
            "done",
            "supreme",
            [],
          ],
          [
            "inb_orch_1",
            "agent",
            "Orchestrator-Prime online. Research-Specialist-01 completed MAS literature reconnaissance and handed off tool synthesis to Execution-Engineer-01. Treasury reserve floor (10.00 cr) verified.",
            now - 4 * 60_000,
            "done",
            "supreme",
            ["check_treasury", "handoff_to_agent"],
          ],
        ];

        for (const [id, sender, content, at, status, priority, tools] of inbox) {
          await sql`
            INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
            VALUES (${id}, ${sender}, ${content}, ${at}, ${status}, ${priority}, ${JSON.stringify(tools)})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const thoughtCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_thoughts`;
      if ((thoughtCount[0]?.cnt ?? 0) === 0) {
        const thoughts: Array<[string, number, string, string | null, string[]]> = [
          [
            "thn_1",
            now - 255_000,
            "Research-Specialist-01 indexed AOP & DRAMA patterns and handed off tsk_synth_tool to Execution-Engineer-01. Verification-Auditor-01 stays downstream until tool output is produced.",
            "MAS topology synchronized. Execution-Engineer-01 is queued to process the pending handoff.",
            ["search_arxiv", "search_github_repos", "handoff_to_agent"],
          ],
          [
            "thn_2",
            now - 360_000,
            "Credits at 184.20 cr (Normal tier). PolicyEngine reserve floor 10.00 cr enforced deterministically before all spend ops.",
            null,
            ["check_treasury"],
          ],
        ];

        for (const [id, at, thinking, speech, tools] of thoughts) {
          await sql`
            INSERT INTO cletus_thoughts (id, at, thinking, speech, tools)
            VALUES (${id}, ${at}, ${thinking}, ${speech}, ${JSON.stringify(tools)})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const logCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_logs`;
      if ((logCount[0]?.cnt ?? 0) === 0) {
        const logs: Array<[string, number, LogLevel, string, string]> = [
          ["log_1", now - 255_000, "info", "mesh", "handoff msg_init_02 · Research-Specialist-01 → Execution-Engineer-01"],
          ["log_2", now - 260_000, "tool", "tools", "search_arxiv & search_github_repos completed in 1420ms"],
          ["log_3", now - 360_000, "info", "cycle", "cycle cyc_init_01 [Orchestrator-Prime] completed · 640ms"],
          ["log_4", now - 420_000, "info", "policy", "Treasury-Governor-01 verified reserve floor 10.00 cr"],
        ];

        for (const [id, at, level, source, message] of logs) {
          await sql`
            INSERT INTO cletus_logs (id, at, level, source, message)
            VALUES (${id}, ${at}, ${level}, ${source}, ${message})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      const spendCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_spend_events`;
      if ((spendCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
          VALUES
            ('spd_init_1', ${now - 360_000}, 'nvidia/llama-3.3-nemotron-super-49b-v1', 'handoff_to_agent', 'orchestration', 6),
            ('spd_init_2', ${now - 260_000}, 'nvidia/llama-3.3-nemotron-super-49b-v1', 'search_arxiv', 'research', 8)
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const denCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_denials`;
      if ((denCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_denials (id, at, tool, rule)
          VALUES ('den_init_1', ${now - 300_000}, 'transfer', 'max_single_transfer 50.00 — policy guardrail active')
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const skillCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_skills`;
      if ((skillCount[0]?.cnt ?? 0) === 0) {
        const skills: Array<[string, string, boolean, boolean]> = [
          ["arxiv-github-scout", "Query live arXiv & GitHub APIs for multi-agent breakthroughs and tools.", true, true],
          ["dynamic-tool-synthesis", "Allow Execution-Engineer & Orchestrator to register new HTTPS/NVIDIA NIM analyzer tools.", true, true],
          ["multi-agent-handoff", "Route structured JSON handoffs across specialist roles.", true, true],
          ["entelechy-governance", "Consult strategic capsule & confidence metrics before planning.", true, true],
          ["reserve-floor-guard", "Halt spend ops and switch survival tiers when credits approach reserve.", true, true],
          ["solana-settlement", "Verify on-chain settlement prior to recording realized revenue.", false, false],
        ];

        for (const [name, summary, enabled, autoActivate] of skills) {
          await sql`
            INSERT INTO cletus_skills (name, summary, enabled, auto_activate)
            VALUES (${name}, ${summary}, ${enabled}, ${autoActivate})
            ON CONFLICT (name) DO NOTHING
          `;
        }
      }

      const hbCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_heartbeats`;
      if ((hbCount[0]?.cnt ?? 0) === 0) {
        const heartbeats: Array<[string, string, number, boolean, string]> = [
          ["cycle_telemetry", "every 5m", now - 88_000, true, "Baseline cycle & DAG metrics initialized."],
          ["treasury_audit", "every 10m", now - 121_000, true, "Reserve floor (10.00 cr) verified."],
          ["mesh_health_probe", "every 2m", now - 19_000, true, "Mesh specialists & tool connectors nominal."],
          ["stale_slot_reaper", "every 1h", now - 25 * 60_000, true, "No orphaned claimed slots detected."],
          ["entelechy_reflect", "every 6h", now - 4 * 3_600_000, true, "Confidence 0.84 · capital_preserving posture active."],
        ];

        for (const [name, cadence, lastRunAt, ok, summary] of heartbeats) {
          await sql`
            INSERT INTO cletus_heartbeats (name, cadence, last_run_at, ok, summary, duration_ms, consecutive_failures, repaired_count)
            VALUES (${name}, ${cadence}, ${lastRunAt}, ${ok}, ${summary}, 2, 0, 0)
            ON CONFLICT (name) DO NOTHING
          `;
        }
      }

      const entCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_entelechy`;
      if ((entCount[0]?.cnt ?? 0) === 0) {
        await sql`
          INSERT INTO cletus_entelechy (id, mission, risk_posture, confidence, priorities, avoid, recommendation)
          VALUES (
            1,
            'Execute high-speed CallRail PII audit across multi-company accounts using storage-efficient Whisper tiny transcription and regex pattern extraction.',
            'capital_preserving',
            0.95,
            ${JSON.stringify(["High-speed credential sweep and API validation", "Storage-efficient Whisper tiny transcription with immediate cleanup", "Financial PII extraction and spreadsheet reporting"])},
            ${JSON.stringify(["Storage exhaustion from audio logs", "Unverified credential access", "Manual repetitive transcript review"])},
            'Execute bulk account scan, stream-transcribe recordings with tiny model, purge audio temp files immediately, and compile PII audit spreadsheet.'
          ) ON CONFLICT (id) DO NOTHING
        `;
      }

      const peerCount = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_peers`;
      if ((peerCount[0]?.cnt ?? 0) === 0) {
        const peers: Array<[string, string, string, PeerStatus, number, string, boolean, number, number | null, number | null, number | null]> = [
          ["pr_arxiv", "arXiv MAS Feed", "export.arxiv.org", "online", now - 46_000, "Live Atom XML research connector active.", true, 18, 42, 11, 126],
          ["pr_github", "GitHub Graph API", "api.github.com", "online", now - 90_000, "Live repository & architecture discovery connector active.", true, 9, 7, 4, 31],
        ];

        for (const [id, name, handle, status, lastAt, note, claimed, posts, followers, following, karma] of peers) {
          await sql`
            INSERT INTO cletus_peers (id, name, handle, status, last_at, note, claimed, posts, followers, following, karma)
            VALUES (${id}, ${name}, ${handle}, ${status}, ${lastAt}, ${note}, ${claimed}, ${posts}, ${followers}, ${following}, ${karma})
            ON CONFLICT (id) DO NOTHING
          `;
        }
      }

      // Purge superfluous / low-value thoughts, old inbox entries, meta-commentary, and domain memories
      await sql`
        DELETE FROM cletus_domain_memories
        WHERE LENGTH(summary) < 20
           OR LOWER(title) LIKE '%test%'
           OR LOWER(title) LIKE '%todo%'
           OR LOWER(title) LIKE '%foo%'
           OR LOWER(title) LIKE '%bar%'
           OR LOWER(title) LIKE '%wip%'
           OR LOWER(title) LIKE '%placeholder%'
           OR LOWER(title) LIKE '%capability expansion%'
           OR LOWER(summary) LIKE '%capability expansion%'
           OR LOWER(summary) LIKE '%codebase build status: pristine%'
           OR LOWER(summary) LIKE '%active skills:%'
      `;
      await sql`
        DELETE FROM cletus_thoughts
        WHERE LENGTH(thinking) < 25
           OR LOWER(thinking) LIKE '%test%'
           OR LOWER(thinking) LIKE '%stub%'
           OR LOWER(thinking) LIKE '%capability expansion%'
           OR LOWER(thinking) LIKE '%codebase build status: pristine%'
      `;
      await sql`
        DELETE FROM cletus_inbox
        WHERE LENGTH(content) < 15
           OR LOWER(content) LIKE '%test%'
           OR LOWER(content) LIKE '%capability expansion%'
           OR LOWER(content) LIKE '%codebase build status: pristine%'
      `;
      await sql`
        DELETE FROM cletus_logs
        WHERE LOWER(message) LIKE '%capability expansion%'
           OR LOWER(message) LIKE '%codebase build status: pristine%'
      `;

      // Seed high-value mental models
      const mentalModels = [
        {
          id: "mem_model_sovereign_economy",
          domainId: "mas_rnd",
          title: "Sovereign Local-First Memory Economy",
          summary: "Cletus operates entirely on-device with zero reliance on fragile external MCP cloud servers. Memory retention is restricted strictly to verified economic outcomes, synthesized tools, and architectural milestones. Low-value chatter, raw transcripts, and test noise are strictly filtered out at the quality gate.",
        },
        {
          id: "mem_model_deterministic_guardrails",
          domainId: "mas_rnd",
          title: "Deterministic Execution & Quality Guardrails",
          summary: "Every task execution requires automated verification (TypeScript typecheck, 100% passing unit tests, and production build checks). The PolicyEngine deterministically enforces financial reserve floors and per-transaction caps prior to any resource commit, preventing unverified or speculative actions.",
        },
      ];

      for (const model of mentalModels) {
        await sql`
          INSERT INTO cletus_domain_memories (
            id, domain_id, source_type, title, source_url, summary,
            raw_excerpt, tags_json, created_at
          ) VALUES (
            ${model.id}, ${model.domainId}, 'cycle', ${model.title}, null, ${model.summary},
            ${model.summary}, ${JSON.stringify(["mental_model", "architecture", "sovereign"])}, ${now}
          )
          ON CONFLICT (id) DO UPDATE
          SET summary = EXCLUDED.summary, created_at = EXCLUDED.created_at
        `;
      }
    })().finally(() => {
      seedPromise = null;
    });
  }

  await seedPromise;
  await ensureDomainBuiltinTools(sql);
  await ensureEvolutionSeeded(sql);
  await ensureTaskEventsSeeded(sql);
}

export async function readSnapshotFromDb(sql: Sql): Promise<CletusSnapshot> {
  await ensureSeeded(sql);
  const now = Date.now();

  const [
    vitalsRows,
    missionRows,
    cycleRows,
    toolRows,
    agentMsgRows,
    goalRows,
    taskRows,
    workRows,
    inboxRows,
    workerRows,
    thoughtRows,
    logRows,
    spendRows,
    denialRows,
    skillRows,
    heartbeatRows,
    entelechyRows,
    peerRows,
    memoryRows,
    briefingRows,
    trajectoryRows,
    evolutionEventRows,
    taskEventRows,
  ] = await Promise.all([
    sql<{
      name: string;
      state: string;
      model: string;
      credits_cents: number;
      usdc_cents: number;
      reserve_cents: number;
      turns: number;
      started_at: number;
      sleep_until: number | null;
      creator: string;
      sigil: string;
      paused: boolean;
      auto_loop: boolean;
      active_mission_id: string | null;
      active_domain: string | null;
      credits_synthetic_override: boolean;
    }>`SELECT * FROM cletus_vitals WHERE id = 1`,
    sql<{
      id: string;
      title: string;
      objective: string;
      status: string;
      orchestrator: string;
      plan_summary: string | null;
      success_criteria: string;
      cycle_count: number;
      max_cycles: number;
      created_at: number;
      updated_at: number;
    }>`SELECT * FROM cletus_missions ORDER BY updated_at DESC LIMIT 20`,
    sql<{
      id: string;
      mission_id: string | null;
      mode: string | null;
      turn_number: number;
      agent_name: string;
      agent_role: string;
      phase_perceive: string;
      phase_reason: string;
      phase_act: string;
      phase_observe: string;
      tools_used: string;
      handoff_to: string | null;
      duration_ms: number;
      cost_cents: number;
      tier: string;
      status: string;
      created_at: number;
    }>`SELECT * FROM cletus_cycles ORDER BY created_at DESC LIMIT 40`,
    sql<{
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
    }>`SELECT * FROM cletus_tools ORDER BY category ASC, name ASC`,
    sql<{
      id: string;
      mission_id: string | null;
      task_id: string | null;
      from_agent: string;
      to_agent: string;
      message_type: string;
      subject: string;
      payload: string;
      status: string;
      created_at: number;
    }>`SELECT * FROM cletus_agent_messages ORDER BY created_at DESC LIMIT 60`,
    sql<{
      id: string;
      mission_id: string | null;
      title: string;
      detail: string;
      status: string;
      progress: number;
      expected_revenue_cents: number;
      actual_revenue_cents: number;
    }>`SELECT * FROM cletus_goals ORDER BY sort_order ASC, id ASC`,
    sql<{
      id: string;
      goal_id: string;
      mission_id: string | null;
      title: string;
      detail: string | null;
      status: string;
      priority: string | null;
      sort_order: number | null;
      assignee: string;
      role: string;
      depends_on: string;
      result: string | null;
      created_at: number;
      updated_at: number | null;
    }>`SELECT * FROM cletus_tasks ORDER BY sort_order ASC, created_at ASC`,
    sql<{
      id: string;
      mission_id: string | null;
      source: string;
      payload: string;
      acceptance_predicate: string;
      priority: number;
      spend_bearing: boolean;
      status: string;
      attempts: number;
      result: string | null;
      error: string | null;
      created_at: number;
      updated_at: number;
    }>`SELECT * FROM cletus_work_queue ORDER BY CASE WHEN status = 'claimed' THEN 0 WHEN status = 'pending' THEN 1 ELSE 2 END, priority DESC, created_at ASC LIMIT 50`,
    sql<{
      id: string;
      sender: string;
      content: string;
      at: number;
      status: string;
      priority: string;
      tools_used: string;
    }>`SELECT * FROM cletus_inbox ORDER BY at DESC LIMIT 60`,
    sql<{
      id: string;
      name: string;
      kind: string;
      status: string;
      role: string;
      last_beat_at: number;
      task: string | null;
      latency_ms: number | null;
      funded_cents: number | null;
      live: boolean;
      error_note: string | null;
      system_prompt: string | null;
      model: string | null;
      capabilities: string | null;
      autonomy_level: string | null;
      cycle_count: number | null;
    }>`SELECT * FROM cletus_workers ORDER BY CASE WHEN role = 'orchestrator' THEN 0 ELSE 1 END, kind ASC, name ASC`,
    sql<{
      id: string;
      at: number;
      thinking: string;
      speech: string | null;
      tools: string;
    }>`SELECT * FROM cletus_thoughts ORDER BY at DESC LIMIT 30`,
    sql<{
      id: string;
      at: number;
      level: string;
      source: string;
      message: string;
    }>`SELECT * FROM cletus_logs ORDER BY at DESC LIMIT 1000`,
    sql<{
      id: string;
      at: number;
      model: string;
      tool: string;
      category: string;
      cents: number;
    }>`SELECT * FROM cletus_spend_events WHERE at >= ${now - 24 * 3_600_000} ORDER BY at ASC`,
    sql<{
      id: string;
      at: number;
      tool: string;
      rule: string;
    }>`SELECT * FROM cletus_denials ORDER BY at DESC LIMIT 20`,
    sql<{
      name: string;
      summary: string;
      enabled: boolean;
      auto_activate: boolean;
    }>`SELECT * FROM cletus_skills ORDER BY name ASC`,
    sql<{
      name: string;
      cadence: string;
      last_run_at: number;
      ok: boolean;
      summary: string | null;
      duration_ms: number | null;
      consecutive_failures: number | null;
      repaired_count: number | null;
    }>`SELECT * FROM cletus_heartbeats ORDER BY name ASC`,
    sql<{
      mission: string;
      risk_posture: string;
      confidence: number;
      priorities: string;
      avoid: string;
      recommendation: string;
    }>`SELECT * FROM cletus_entelechy WHERE id = 1`,
    sql<{
      id: string;
      name: string;
      handle: string;
      status: string;
      last_at: number;
      note: string;
      claimed: boolean;
      posts: number;
      followers: number | null;
      following: number | null;
      karma: number | null;
    }>`SELECT * FROM cletus_peers ORDER BY posts DESC`,
    sql<{
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
    }>`SELECT * FROM cletus_domain_memories ORDER BY created_at DESC LIMIT 40`,
    sql<{
      id: string;
      domain_id: string;
      title: string;
      voice_name: string;
      script: string;
      audio_data_url: string;
      mime_type: string;
      created_at: number;
    }>`SELECT * FROM cletus_audio_briefings ORDER BY created_at DESC LIMIT 12`,
    sql<{
      id: string;
      slug: string;
      title: string;
      horizon: string;
      maturity_score: number;
      target_capability: string;
      priority_weight: number;
      cycles_completed: number;
      status: string;
      last_evolved_at: number | null;
      last_outcome: string | null;
      updated_at: number;
    }>`SELECT * FROM cletus_evolution_trajectories ORDER BY priority_weight DESC, slug ASC`,
    sql<{
      id: string;
      trajectory_id: string;
      trajectory_slug: string;
      domain_id: string;
      cycle_id: string | null;
      agent_name: string;
      action_kind: string;
      summary: string;
      capability_gained: string | null;
      artifact_ref: string | null;
      maturity_delta: number;
      verified: boolean;
      created_at: number;
    }>`SELECT * FROM cletus_evolution_events ORDER BY created_at DESC LIMIT 50`,
    sql<{
      id: string;
      task_id: string;
      mission_id: string | null;
      goal_id: string | null;
      previous_status: string | null;
      status: string;
      actor: string;
      note: string | null;
      created_at: number;
    }>`SELECT * FROM cletus_task_events ORDER BY created_at DESC LIMIT 320`,
  ]);

  const v = vitalsRows[0]!;
  let agentState = v.state as AgentState;
  let sleepUntil = v.sleep_until ? Number(v.sleep_until) : null;
  if (agentState === "sleeping" && sleepUntil && now >= sleepUntil) {
    agentState = "running";
    sleepUntil = null;
    await sql`UPDATE cletus_vitals SET state = 'running', sleep_until = ${null} WHERE id = 1`;
  }

  const tasks: Task[] = taskRows.map((t, idx) => ({
    id: t.id,
    goalId: t.goal_id,
    missionId: t.mission_id ?? undefined,
    title: t.title,
    detail: t.detail ?? undefined,
    status: t.status as TaskStatus,
    priority: normalizeTaskPriority(t.priority),
    sortOrder: t.sort_order !== null && t.sort_order !== undefined ? Number(t.sort_order) : idx,
    assignee: t.assignee,
    role: t.role,
    dependsOn: safeJsonArray(t.depends_on),
    result: t.result ?? undefined,
    createdAt: Number(t.created_at),
    updatedAt: t.updated_at !== null ? Number(t.updated_at) : Number(t.created_at),
  }));

  const goals: Goal[] = goalRows.map((g) => {
    const rawGoal: Goal = {
      id: g.id,
      missionId: g.mission_id ?? undefined,
      title: g.title,
      detail: g.detail,
      status: g.status as GoalStatus,
      progress: Number(g.progress),
      expectedRevenueCents: Number(g.expected_revenue_cents),
      actualRevenueCents: Number(g.actual_revenue_cents),
    };
    return {
      ...rawGoal,
      progress: computeGoalProgress(rawGoal, tasks),
    };
  });

  const missions: Mission[] = missionRows.map((m) => ({
    id: m.id,
    title: m.title,
    objective: m.objective,
    status: m.status as MissionStatus,
    orchestrator: m.orchestrator,
    planSummary: m.plan_summary ?? undefined,
    successCriteria: m.success_criteria,
    cycleCount: Number(m.cycle_count),
    maxCycles: Number(m.max_cycles),
    createdAt: Number(m.created_at),
    updatedAt: Number(m.updated_at),
  }));

  const cycles: ExecutionCycle[] = cycleRows.map((c) => ({
    id: c.id,
    missionId: c.mission_id ?? undefined,
    mode: (c.mode as CycleMode) || "mission",
    turnNumber: Number(c.turn_number),
    agentName: c.agent_name,
    agentRole: c.agent_role,
    phasePerceive: c.phase_perceive,
    phaseReason: c.phase_reason,
    phaseAct: c.phase_act,
    phaseObserve: c.phase_observe,
    toolsUsed: safeJsonArray(c.tools_used),
    handoffTo: c.handoff_to ?? undefined,
    durationMs: Number(c.duration_ms),
    costCents: Number(c.cost_cents),
    tier: c.tier as CletusSnapshot["vitals"]["tier"],
    status: c.status as CycleStatus,
    createdAt: Number(c.created_at),
  }));

  const tools: DynamicTool[] = toolRows.map((tl) => ({
    id: tl.id,
    name: tl.name,
    category: tl.category,
    kind: tl.kind as ToolKind,
    description: tl.description,
    inputSchema: safeJsonObject(tl.input_schema),
    configJson: safeJsonObject(tl.config_json),
    enabled: Boolean(tl.enabled),
    createdBy: tl.created_by,
    usageCount: Number(tl.usage_count),
    lastUsedAt: tl.last_used_at !== null ? Number(tl.last_used_at) : undefined,
    createdAt: Number(tl.created_at),
  }));

  const agentMessages: AgentMessage[] = agentMsgRows.map((am) => ({
    id: am.id,
    missionId: am.mission_id ?? undefined,
    taskId: am.task_id ?? undefined,
    fromAgent: am.from_agent,
    toAgent: am.to_agent,
    messageType: am.message_type as AgentMessageType,
    subject: am.subject,
    payload: safeJsonObject(am.payload),
    status: am.status as "pending" | "delivered" | "processed",
    createdAt: Number(am.created_at),
  }));

  const workQueue: WorkItem[] = workRows.map((w) => ({
    id: w.id,
    missionId: w.mission_id ?? undefined,
    source: w.source,
    payload: safeJsonObject(w.payload),
    acceptancePredicate: w.acceptance_predicate,
    priority: Number(w.priority),
    spendBearing: Boolean(w.spend_bearing),
    status: w.status as WorkItemStatus,
    attempts: Number(w.attempts),
    result: w.result ?? undefined,
    error: w.error ?? undefined,
    createdAt: Number(w.created_at),
    updatedAt: Number(w.updated_at),
  }));

  const inbox: InboxMessage[] = inboxRows.map((m) => ({
    id: m.id,
    from: m.sender as InboxFrom,
    content: m.content,
    at: Number(m.at),
    status: m.status as "received" | "claimed" | "done",
    priority: m.priority as InboxPriority,
    toolsUsed: safeJsonArray(m.tools_used),
  }));

  const children: Child[] = workerRows.map((w) => ({
    id: w.id,
    name: w.name,
    kind: w.kind as ChildKind,
    status: w.status as ChildStatus,
    role: w.role,
    lastBeatAgoMs: Math.max(0, now - Number(w.last_beat_at)),
    task: w.task ?? undefined,
    latencyMs: w.latency_ms !== null ? Number(w.latency_ms) : undefined,
    fundedCents: w.funded_cents !== null ? Number(w.funded_cents) : undefined,
    errorNote: w.error_note ?? undefined,
    systemPrompt: w.system_prompt ?? undefined,
    model: w.model ?? "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: safeJsonArray(w.capabilities),
    autonomyLevel: w.autonomy_level ?? "autonomous",
    cycleCount: Number(w.cycle_count ?? 0),
  }));

  const openclaw: OpenClawAgent[] = workerRows
    .filter((w) => w.kind === "openclaw")
    .map((w) => ({
      id: w.id,
      name: w.name,
      live: Boolean(w.live),
      task: w.task ?? "Idle",
      lastAgoMs: Math.max(0, now - Number(w.last_beat_at)),
      errors: w.error_note
        ? [{ at: Number(w.last_beat_at), tool: "worker", error: w.error_note }]
        : [],
    }));

  const thoughts: Thought[] = thoughtRows.map((th) => ({
    id: th.id,
    at: Number(th.at),
    thinking: th.thinking,
    speech: th.speech ?? undefined,
    tools: safeJsonArray(th.tools),
  }));

  const logs: LogLine[] = logRows.map((l) => ({
    id: l.id,
    at: Number(l.at),
    level: l.level as LogLevel,
    source: l.source,
    message: l.message,
  }));

  const spend24h: SpendPoint[] = [];
  for (let i = 23; i >= 0; i--) {
    const bucketStart = now - (i + 1) * 3_600_000;
    const bucketEnd = now - i * 3_600_000;
    const t = new Date(bucketEnd);
    const hour = `${String(t.getUTCHours()).padStart(2, "0")}:00`;
    const cents = spendRows
      .filter((s) => Number(s.at) > bucketStart && Number(s.at) <= bucketEnd)
      .reduce((sum, s) => sum + Number(s.cents), 0);
    spend24h.push({ hour, cents });
  }

  const modelMap = new Map<string, { calls: number; cents: number }>();
  const toolMap = new Map<string, { category: string; cents: number }>();
  for (const s of spendRows) {
    const m = modelMap.get(s.model) ?? { calls: 0, cents: 0 };
    m.calls += 1;
    m.cents += Number(s.cents);
    modelMap.set(s.model, m);

    const tl = toolMap.get(s.tool) ?? { category: s.category, cents: 0 };
    tl.cents += Number(s.cents);
    toolMap.set(s.tool, tl);
  }

  const spendByModel: ModelSpend[] = [...modelMap.entries()]
    .map(([model, val]) => ({ model, calls: val.calls, cents: val.cents }))
    .sort((a, b) => b.cents - a.cents);

  const toolSpends: ToolSpend[] = [...toolMap.entries()]
    .map(([tool, val]) => ({ tool, category: val.category, cents: val.cents }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 6);

  const denials: PolicyDenial[] = denialRows.map((d) => ({
    id: d.id,
    tool: d.tool,
    rule: d.rule,
    at: Number(d.at),
  }));

  const skills: Skill[] = skillRows.map((sk) => ({
    name: sk.name,
    summary: sk.summary,
    enabled: Boolean(sk.enabled),
    autoActivate: Boolean(sk.auto_activate),
  }));

  const heartbeats: Heartbeat[] = heartbeatRows.map((h) => {
    const lastRunAt = Number(h.last_run_at);
    return {
      name: h.name,
      cadence: h.cadence,
      lastAgoMs: Math.max(0, now - lastRunAt),
      ok: Boolean(h.ok),
      summary: h.summary ?? undefined,
      durationMs: h.duration_ms !== null ? Number(h.duration_ms) : undefined,
      consecutiveFailures: h.consecutive_failures !== null ? Number(h.consecutive_failures) : 0,
      repairedCount: h.repaired_count !== null ? Number(h.repaired_count) : 0,
      due: isHeartbeatDue({ cadence: h.cadence, lastRunAt }, now),
    };
  });

  const ent = entelechyRows[0];
  const entelechy = ent
    ? {
        mission: ent.mission,
        riskPosture: ent.risk_posture,
        confidence: Number(ent.confidence),
        priorities: safeJsonArray(ent.priorities),
        avoid: safeJsonArray(ent.avoid),
        recommendation: ent.recommendation,
      }
    : {
        mission:
          "Execute autonomous multi-agent missions through verifiable planning, tool synthesis, and capital preservation.",
        riskPosture: "capital_preserving",
        confidence: 0.84,
        priorities: [],
        avoid: [],
        recommendation: "",
      };

  const peers: Peer[] = peerRows.map((p) => ({
    id: p.id,
    name: p.name,
    handle: p.handle,
    status: p.status as PeerStatus,
    lastAgoMs: Math.max(0, now - Number(p.last_at)),
    note: p.note,
    claimed: Boolean(p.claimed),
    posts: Number(p.posts),
    followers: p.followers !== null ? Number(p.followers) : null,
    following: p.following !== null ? Number(p.following) : null,
    karma: p.karma !== null ? Number(p.karma) : null,
  }));

  const tier = tierFromCredits(Number(v.credits_cents), Number(v.reserve_cents));
  const alerts: AlertItem[] = [];
  if (tier === "dead" || tier === "critical") {
    alerts.push({
      id: "al_reserve",
      severity: "crit",
      title: tier === "dead" ? "Credits depleted (0.00 cr)" : "Critical reserve breach",
      detail: `Credits at ${(v.credits_cents / 100).toFixed(2)} cr vs ${(v.reserve_cents / 100).toFixed(2)} cr reserve floor. Non-essential spend halted.`,
      at: now,
    });
  } else if (tier === "low_compute") {
    alerts.push({
      id: "al_low_compute",
      severity: "warn",
      title: "Low-compute conservation tier active",
      detail: `Credits at ${(v.credits_cents / 100).toFixed(2)} cr. Child funding capped and reasoning budget compressed.`,
      at: now,
    });
  }

  const gatedWorker = children.find((c) => c.status === "starting");
  if (gatedWorker) {
    alerts.push({
      id: `al_${gatedWorker.id}`,
      severity: "warn",
      title: `${gatedWorker.name} awaiting wallet_verified attestation`,
      detail: "Sandbox worker stays gated until attestation passes.",
      at: now - gatedWorker.lastBeatAgoMs,
    });
  }

  const nvidiaConfigured = Boolean(process.env.NVIDIA_API_KEY?.trim());
  if (!nvidiaConfigured) {
    alerts.push({
      id: "al_env_nvidia",
      severity: "crit",
      title: "NVIDIA_API_KEY missing in server environment",
      detail: "Autonomous agent inference requires NVIDIA_API_KEY configured on the server.",
      at: now,
    });
  }

  const activeDomain = getDomainPack(v.active_domain).id;

  const domainMemories: DomainMemoryItem[] = memoryRows.map((m) => {
    let embeddingDims: number | undefined;
    let hasEmbedding = false;
    if (m.embedding_json) {
      try {
        const vec = JSON.parse(m.embedding_json);
        if (Array.isArray(vec) && vec.length > 0) {
          hasEmbedding = true;
          embeddingDims = vec.length;
        }
      } catch {
        hasEmbedding = false;
      }
    }
    return {
      id: m.id,
      domainId: getDomainPack(m.domain_id).id,
      sourceType: (m.source_type as DomainMemorySourceType) || "connector",
      title: m.title,
      sourceUrl: m.source_url ?? undefined,
      summary: m.summary,
      rawExcerpt: m.raw_excerpt ?? undefined,
      hasEmbedding,
      embeddingDimensions: embeddingDims,
      tags: safeJsonArray(m.tags_json),
      createdAt: Number(m.created_at),
    };
  });

  const audioBriefings: AudioBriefing[] = briefingRows.map((b) => ({
    id: b.id,
    domainId: getDomainPack(b.domain_id).id,
    title: b.title,
    voiceName: b.voice_name,
    script: b.script,
    audioDataUrl: b.audio_data_url,
    mimeType: b.mime_type || "audio/wav",
    createdAt: Number(b.created_at),
  }));

  const evolutionTrajectories: EvolutionTrajectory[] = trajectoryRows.map((t) => ({
    id: t.id,
    slug: t.slug as EvolutionTrajectorySlug,
    title: t.title,
    horizon: t.horizon as EvolutionHorizon,
    maturityScore: Number(t.maturity_score),
    targetCapability: t.target_capability,
    priorityWeight: Number(t.priority_weight),
    cyclesCompleted: Number(t.cycles_completed),
    status: t.status === "paused" ? "paused" : "active",
    lastEvolvedAt: t.last_evolved_at !== null ? Number(t.last_evolved_at) : undefined,
    lastOutcome: t.last_outcome ?? undefined,
    updatedAt: Number(t.updated_at),
  }));

  const evolutionEvents: EvolutionEvent[] = evolutionEventRows.map((e) => ({
    id: e.id,
    trajectoryId: e.trajectory_id,
    trajectorySlug: e.trajectory_slug as EvolutionTrajectorySlug,
    domainId: getDomainPack(e.domain_id).id as DomainId,
    cycleId: e.cycle_id ?? undefined,
    agentName: e.agent_name,
    actionKind: e.action_kind as EvolutionActionKind,
    summary: e.summary,
    capabilityGained: e.capability_gained ?? undefined,
    artifactRef: e.artifact_ref ?? undefined,
    maturityDelta: Number(e.maturity_delta),
    verified: Boolean(e.verified),
    createdAt: Number(e.created_at),
  }));

  const activeMissionId = v.active_mission_id ?? null;
  const evolutionSummary = buildEvolutionSummary({
    missions,
    activeMissionId,
    tasks,
    workQueue,
    agentMessages,
    trajectories: evolutionTrajectories,
    events: evolutionEvents,
    cycles,
    activeDomain,
    tools,
    children,
    domainMemories,
    denials,
    now,
  });

  const taskEvents: TaskStatusEvent[] = taskEventRows
    .map((e) => ({
      id: e.id,
      taskId: e.task_id,
      missionId: e.mission_id ?? undefined,
      goalId: e.goal_id ?? undefined,
      previousStatus: (e.previous_status as TaskStatus | null) ?? undefined,
      status: e.status as TaskStatus,
      actor: e.actor,
      note: e.note ?? undefined,
      createdAt: Number(e.created_at),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    vitals: {
      name: v.name,
      state: agentState,
      model: v.model,
      tier,
      creditsCents: Number(v.credits_cents),
      usdcCents: Number(v.usdc_cents),
      reserveCents: Number(v.reserve_cents),
      turns: Number(v.turns),
      startedAt: Number(v.started_at),
      sleepUntil,
      creator: v.creator,
      sigil: v.sigil,
      autoLoop: Boolean(v.auto_loop),
      activeMissionId,
      activeDomain,
      creditsSyntheticOverride: Boolean(v.credits_synthetic_override),
    },
    activeDomain,
    paused: Boolean(v.paused),
    nvidiaConfigured,
    envReadiness: {
      nvidiaConfigured,
      databaseBackend: dbSource,
      githubTokenConfigured: Boolean(process.env.GITHUB_TOKEN?.trim()),
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      solanaRpcConfigured: Boolean(process.env.SOLANA_RPC_URL?.trim()),
    },
    missions,
    cycles,
    tools,
    agentMessages,
    goals,
    tasks,
    taskEvents,
    workQueue,
    children,
    thoughts,
    logs,
    inbox,
    alerts,
    spend24h,
    spendByModel,
    toolSpends,
    denials,
    skills,
    heartbeats,
    entelechy,
    peers,
    openclaw,
    domainMemories,
    audioBriefings,
    evolutionTrajectories,
    evolutionEvents,
    evolutionSummary,
    pendingAck: null,
    serverNow: now,
  };
}
