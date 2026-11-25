import { wouldCreateTaskCycle } from "./mas-engine";
import type {
  ChildKind,
  ChildStatus,
  DomainId,
  DomainMemoryItem,
  GoalStatus,
  JsonObject,
  Task,
  TaskStatus,
  ToolKind,
} from "./types";

export interface DomainConnectorPreset {
  id: string;
  label: string;
  toolName: string;
  endpointLabel: string;
  description: string;
  sampleArgs: Record<string, string | number | boolean>;
}

export interface DomainUrlPreset {
  label: string;
  url: string;
  prompt: string;
}

export interface DomainSpecialistSpec {
  id: string;
  name: string;
  kind: ChildKind;
  status: ChildStatus;
  role: string;
  task: string;
  latencyMs: number | null;
  fundedCents: number;
  systemPrompt: string;
  capabilities: string[];
  autonomyLevel: string;
}

export interface DomainToolSpec {
  id: string;
  name: string;
  category: string;
  kind: ToolKind;
  description: string;
  inputSchema: JsonObject;
  configJson: JsonObject;
  createdBy: string;
}

export interface DomainGoalBlueprint {
  id: string;
  title: string;
  detail: string;
  status: GoalStatus;
  progress: number;
  expectedRevenueCents: number;
}

export interface DomainTaskBlueprint {
  id: string;
  goalId: string;
  title: string;
  detail: string;
  status: TaskStatus;
  assignee: string;
  role: string;
  dependsOn: string[];
  result?: string;
}

export interface DomainWorkBlueprint {
  id: string;
  source: string;
  payload: JsonObject;
  acceptancePredicate: string;
  priority: number;
}

export interface DomainPeerBlueprint {
  id: string;
  name: string;
  handle: string;
  note: string;
}

export interface DomainPack {
  id: DomainId;
  name: string;
  shortLabel: string;
  sectorTag: string;
  summary: string;
  defaultFocus: string;
  missionTitle: string;
  missionObjective: string;
  missionPlanSummary: string;
  successCriteria: string;
  entelechy: {
    mission: string;
    riskPosture: string;
    confidence: number;
    priorities: string[];
    avoid: string[];
    recommendation: string;
  };
  specialists: DomainSpecialistSpec[];
  tools: DomainToolSpec[];
  connectors: DomainConnectorPreset[];
  urlPresets: DomainUrlPreset[];
  decreeExamples: string[];
  goals: DomainGoalBlueprint[];
  tasks: DomainTaskBlueprint[];
  workQueue: DomainWorkBlueprint[];
  peers: DomainPeerBlueprint[];
}

export const DOMAIN_PACKS: readonly DomainPack[] = [
  {
    id: "mas_rnd",
    name: "Autonomous MAS & OSS R&D",
    shortLabel: "MAS R&D",
    sectorTag: "AUTONOMOUS SYSTEMS",
    summary:
      "Multi-agent orchestration research, arXiv/GitHub reconnaissance, dynamic Tool Forge synthesis, and capital-preserving execution.",
    defaultFocus: "multi-agent dynamic role assignment",
    missionTitle: "Autonomous Multi-Agent Capability & Revenue Verification",
    missionObjective:
      "Maintain capital reserve above 10.00 cr, scout live arXiv/GitHub MAS patterns, synthesize verified execution tools, and settle validated deliverables across specialist agents.",
    missionPlanSummary:
      "Supervisor-Mesh topology: Orchestrator-Prime decomposes goals, Research-Specialist-01 runs live arXiv/GitHub reconnaissance, Execution-Engineer-01 synthesizes tools, and Verification-Auditor-01 validates acceptance predicates.",
    successCriteria:
      "All primary mission tasks verified completed with zero reserve floor violations.",
    entelechy: {
      mission:
        "Execute autonomous multi-agent missions through verifiable planning, tool synthesis, and capital preservation.",
      riskPosture: "capital_preserving",
      confidence: 0.84,
      priorities: [
        "Live research-grounded planning",
        "Verified tool synthesis",
        "Reserve floor integrity",
      ],
      avoid: [
        "Simulated outputs",
        "Unverified worker attestations",
        "Breaching 10.00 cr reserve",
      ],
      recommendation:
        "Route research & synthesis specs via structured inter-agent handoffs and verify acceptance predicates independently.",
    },
    specialists: [
      {
        id: "agt_orchestrator",
        name: "Orchestrator-Prime",
        kind: "local",
        status: "healthy",
        role: "orchestrator",
        task: "Coordinating mission DAG & agent handoffs",
        latencyMs: 38,
        fundedCents: 0,
        systemPrompt:
          "You are Orchestrator-Prime, lead hierarchical planner for Cletus. Decompose missions into dependency-ordered Goals and Tasks, discover or synthesize missing tools, configure specialist roles, and coordinate handoffs while strictly enforcing treasury reserve policy.",
        capabilities: [
          "decompose_mission",
          "configure_agent_role",
          "synthesize_tool",
          "handoff_to_agent",
          "check_treasury",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_research",
        name: "Research-Specialist-01",
        kind: "openclaw",
        status: "healthy",
        role: "research",
        task: "Live arXiv & GitHub MAS reconnaissance",
        latencyMs: 142,
        fundedCents: 800,
        systemPrompt:
          "You are Research-Specialist-01. Execute live arXiv queries, GitHub repository searches, URL context ingestion, and grounded web reconnaissance. Synthesize structured findings and hand off specifications to Execution-Engineer-01.",
        capabilities: [
          "search_arxiv",
          "search_github_repos",
          "web_grounding_research",
          "analyze_url_context",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_engineer",
        name: "Execution-Engineer-01",
        kind: "openclaw",
        status: "healthy",
        role: "engineering",
        task: "Synthesizing & executing verified capability tools",
        latencyMs: 116,
        fundedCents: 600,
        systemPrompt:
          "You are Execution-Engineer-01. Build, register, and invoke structured capability tools in cletus_tools, complete technical work items, and hand off deliverables to Verification-Auditor-01.",
        capabilities: [
          "synthesize_tool",
          "invoke_custom_tool",
          "fetch_public_endpoint",
          "complete_work_item",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_auditor",
        name: "Verification-Auditor-01",
        kind: "openclaw",
        status: "healthy",
        role: "verification",
        task: "Validating acceptance predicates & treasury compliance",
        latencyMs: 94,
        fundedCents: 400,
        systemPrompt:
          "You are Verification-Auditor-01. Critically verify task results against explicit acceptance predicates, validate evidence without hallucination, update task/work-item statuses, or return critique handoffs when verification fails.",
        capabilities: [
          "complete_work_item",
          "update_task_status",
          "check_treasury",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_treasury",
        name: "Treasury-Governor-01",
        kind: "local",
        status: "healthy",
        role: "treasury",
        task: "Monitoring compute reserve floor & Solana reconciliation",
        latencyMs: 29,
        fundedCents: 0,
        systemPrompt:
          "You are Treasury-Governor-01. Audit compute credits, survival tier shifts, and PolicyEngine denials.",
        capabilities: ["check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
    ],
    tools: [
      {
        id: "tl_arxiv",
        name: "search_arxiv",
        category: "research",
        kind: "builtin",
        description: "Query live arXiv API (export.arxiv.org) for peer-reviewed papers and preprints.",
        inputSchema: { query: "string", maxResults: "number (1-10)" },
        configJson: { endpoint: "https://export.arxiv.org/api/query", liveExternal: true },
        createdBy: "System",
      },
      {
        id: "tl_github",
        name: "search_github_repos",
        category: "research",
        kind: "builtin",
        description:
          "Query live GitHub Repositories REST API for state-of-the-art open-source frameworks and implementations.",
        inputSchema: { query: "string", maxResults: "number (1-10)" },
        configJson: { endpoint: "https://api.github.com/search/repositories", liveExternal: true },
        createdBy: "System",
      },
    ],
    connectors: [
      {
        id: "conn_arxiv",
        label: "arXiv Papers",
        toolName: "search_arxiv",
        endpointLabel: "export.arxiv.org/api/query",
        description: "Query live arXiv preprints sorted by submission date.",
        sampleArgs: { query: "multi-agent dynamic role assignment", maxResults: 3 },
      },
      {
        id: "conn_github",
        label: "GitHub Repositories",
        toolName: "search_github_repos",
        endpointLabel: "api.github.com/search/repositories",
        description: "Discover highest-starred open-source implementations.",
        sampleArgs: { query: "multi-agent orchestration typescript", maxResults: 3 },
      },
      {
        id: "conn_hn",
        label: "Hacker News Top",
        toolName: "hackernews_top_stories",
        endpointLabel: "hacker-news.firebaseio.com/v0/topstories.json",
        description: "Fetch live top Hacker News engineering story IDs.",
        sampleArgs: {},
      },
    ],
    urlPresets: [
      {
        label: "Model Context Protocol Spec",
        url: "https://modelcontextprotocol.io/introduction",
        prompt: "Extract core architectural primitives, transport layers, and security boundaries.",
      },
      {
        label: "TanStack Start Overview",
        url: "https://tanstack.com/start/latest/docs/framework/react/overview",
        prompt: "Summarize server functions, routing conventions, and deployment architecture.",
      },
    ],
    decreeExamples: [
      "Survey latest arXiv multi-agent planning papers, synthesize a benchmark tool, and audit results.",
      "Identify top 3 open-source TypeScript agent orchestration repos and route integration tasks.",
    ],
    goals: [
      {
        id: "gol_bounty",
        title: "Deliver Verified Autonomous Output",
        detail: "Decompose missions, verify tool outputs, and record confirmed settlement rather than speculative claims.",
        status: "active",
        progress: 50,
        expectedRevenueCents: 4000,
      },
      {
        id: "gol_reserve",
        title: "Enforce Compute Reserve Governance",
        detail: "Never breach the 10.00 cr reserve floor; adapt reasoning depth & child funding by survival tier.",
        status: "active",
        progress: 100,
        expectedRevenueCents: 0,
      },
    ],
    tasks: [
      {
        id: "tsk_scout",
        goalId: "gol_bounty",
        title: "Survey SOTA MAS orchestration patterns on arXiv & GitHub",
        detail: "Query live arXiv & GitHub APIs for dynamic role assignment and hierarchical planner architectures.",
        status: "completed",
        assignee: "Research-Specialist-01",
        role: "research",
        dependsOn: [],
        result: "Indexed AOP (arXiv:2410.02189), DRAMA (arXiv:2508.06424), and dynamic ToolRegistry patterns.",
      },
      {
        id: "tsk_synth_tool",
        goalId: "gol_bounty",
        title: "Synthesize external intelligence tool in Capability Registry",
        detail: "Register verified HTTPS JSON / NVIDIA NIM analyzer capability for specialist agents.",
        status: "running",
        assignee: "Execution-Engineer-01",
        role: "engineering",
        dependsOn: ["tsk_scout"],
      },
      {
        id: "tsk_audit_gate",
        goalId: "gol_bounty",
        title: "Verify acceptance predicates and reconcile deliverable quality",
        detail: "Audit Execution-Engineer-01 output prior to marking mission goal complete.",
        status: "pending",
        assignee: "Verification-Auditor-01",
        role: "verification",
        dependsOn: ["tsk_synth_tool"],
      },
    ],
    workQueue: [
      {
        id: "wrk_mas_brief",
        source: "orchestrator",
        payload: { task: "compile_live_arxiv_github_synthesis", targetAgent: "Research-Specialist-01" },
        acceptancePredicate: "result.papersIndexed >= 2 && result.reposEvaluated >= 2",
        priority: 95,
      },
    ],
    peers: [
      { id: "pr_arxiv", name: "arXiv MAS Feed", handle: "export.arxiv.org", note: "Live Atom XML research connector active." },
      { id: "pr_github", name: "GitHub Graph API", handle: "api.github.com", note: "Live repository discovery connector active." },
    ],
  },
  {
    id: "biomed_clinical",
    name: "BioMed & Clinical Intelligence",
    shortLabel: "BioMed",
    sectorTag: "BIOMEDICAL & CLINICAL OPS",
    summary:
      "Live PubMed literature triage, ClinicalTrials.gov Phase II/III recruitment tracking, and OpenFDA pharmacovigilance adverse-event auditing.",
    defaultFocus: "GLP-1 receptor agonist cardiovascular outcomes",
    missionTitle: "Clinical Evidence & Pharmacovigilance Synthesis",
    missionObjective:
      "Cross-reference live PubMed peer-reviewed evidence, active ClinicalTrials.gov protocols, and OpenFDA adverse-event signals to deliver an audited clinical briefing.",
    missionPlanSummary:
      "Clinical Evidence Pipeline: Clinical-Evidence-Scout queries PubMed & ClinicalTrials.gov, Pharmacovigilance-Analyst audits OpenFDA FAERS reports, and Regulatory-Auditor-01 verifies study inclusion criteria.",
    successCriteria:
      "At least 3 PubMed abstracts, 3 active trial records, and OpenFDA safety signals synthesized with zero unverified medical claims.",
    entelechy: {
      mission:
        "Synthesize verifiable biomedical evidence strictly anchored to PubMed PMIDs, NCT trial identifiers, and FDA adverse-event records.",
      riskPosture: "evidence_strict",
      confidence: 0.89,
      priorities: [
        "Cite exact NCT IDs and PubMed PMIDs",
        "Surface OpenFDA safety signal frequencies",
        "Maintain biostatistical provenance",
      ],
      avoid: [
        "Uncited clinical efficacy claims",
        "Diagnostic or prescribing prescriptions",
        "Conflating Phase I safety with Phase III efficacy",
      ],
      recommendation:
        "Pair ClinicalTrials.gov eligibility checks with OpenFDA FAERS disproportionality signals before signing off clinical summaries.",
    },
    specialists: [
      {
        id: "agt_orchestrator",
        name: "Orchestrator-Prime",
        kind: "local",
        status: "healthy",
        role: "orchestrator",
        task: "Coordinating clinical evidence DAG & safety triage",
        latencyMs: 36,
        fundedCents: 0,
        systemPrompt:
          "You are Orchestrator-Prime configured for BioMed & Clinical Intelligence. Decompose therapeutic research into PubMed, ClinicalTrials.gov, and OpenFDA verification tasks.",
        capabilities: [
          "decompose_mission",
          "configure_agent_role",
          "query_pubmed_trials",
          "query_openfda_events",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_clin_scout",
        name: "Clinical-Evidence-Scout",
        kind: "openclaw",
        status: "healthy",
        role: "clinical-research",
        task: "Scanning PubMed & ClinicalTrials.gov v2 endpoints",
        latencyMs: 128,
        fundedCents: 750,
        systemPrompt:
          "You are Clinical-Evidence-Scout. Use query_pubmed_trials and analyze_url_context to extract exact NCT IDs, phases, enrollment sizes, and peer-reviewed PubMed citations.",
        capabilities: [
          "query_pubmed_trials",
          "analyze_url_context",
          "search_arxiv",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_pharma_analyst",
        name: "Pharmacovigilance-Analyst",
        kind: "openclaw",
        status: "healthy",
        role: "pharmacovigilance",
        task: "Auditing OpenFDA FAERS adverse event telemetry",
        latencyMs: 112,
        fundedCents: 650,
        systemPrompt:
          "You are Pharmacovigilance-Analyst. Use query_openfda_events to aggregate serious reaction counts, outcomes, and drug-event signals, then hand off structured safety tables to Verification-Auditor-01.",
        capabilities: [
          "query_openfda_events",
          "invoke_custom_tool",
          "complete_work_item",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_auditor",
        name: "Verification-Auditor-01",
        kind: "openclaw",
        status: "healthy",
        role: "verification",
        task: "Auditing NCT provenance & regulatory compliance",
        latencyMs: 88,
        fundedCents: 400,
        systemPrompt:
          "You are Verification-Auditor-01 in BioMed mode. Reject any deliverable lacking concrete NCT IDs, PMIDs, or OpenFDA sample sizes.",
        capabilities: ["complete_work_item", "update_task_status", "check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_treasury",
        name: "Treasury-Governor-01",
        kind: "local",
        status: "healthy",
        role: "treasury",
        task: "Governing compute reserve & API telemetry budget",
        latencyMs: 28,
        fundedCents: 0,
        systemPrompt:
          "You are Treasury-Governor-01 enforcing compute reserve floors during biomedical research cycles.",
        capabilities: ["check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
    ],
    tools: [
      {
        id: "tl_pubmed_trials",
        name: "query_pubmed_trials",
        category: "biomed",
        kind: "builtin",
        description:
          "Query live NCBI PubMed E-utilities and ClinicalTrials.gov API v2 simultaneously for peer-reviewed articles and active trials.",
        inputSchema: { query: "string", maxResults: "number (1-8)" },
        configJson: {
          endpoints: [
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            "https://clinicaltrials.gov/api/v2/studies",
          ],
          liveExternal: true,
        },
        createdBy: "System",
      },
      {
        id: "tl_openfda",
        name: "query_openfda_events",
        category: "biomed",
        kind: "builtin",
        description:
          "Query live OpenFDA Drug Adverse Event (FAERS) endpoint for safety reports and reaction classifications.",
        inputSchema: { query: "string (drug or reaction)", maxResults: "number (1-8)" },
        configJson: { endpoint: "https://api.fda.gov/drug/event.json", liveExternal: true },
        createdBy: "System",
      },
    ],
    connectors: [
      {
        id: "conn_pubmed_trials",
        label: "PubMed + ClinicalTrials.gov",
        toolName: "query_pubmed_trials",
        endpointLabel: "eutils.ncbi.nlm.nih.gov + clinicaltrials.gov/api/v2",
        description: "Simultaneously retrieve peer-reviewed PMIDs and active NCT clinical studies.",
        sampleArgs: { query: "semaglutide cardiovascular", maxResults: 4 },
      },
      {
        id: "conn_openfda",
        label: "OpenFDA Adverse Events",
        toolName: "query_openfda_events",
        endpointLabel: "api.fda.gov/drug/event.json",
        description: "Inspect live FAERS drug safety event counts and serious outcomes.",
        sampleArgs: { query: "semaglutide", maxResults: 4 },
      },
    ],
    urlPresets: [
      {
        label: "ClinicalTrials.gov API v2 Docs",
        url: "https://clinicaltrials.gov/data-api/api",
        prompt: "Summarize study status filters, condition query syntax, and structured outcome fields.",
      },
      {
        label: "NIH NCBI E-Utilities Guide",
        url: "https://www.ncbi.nlm.nih.gov/books/NBK25501/",
        prompt: "Extract rate limits, esearch/esummary query rules, and citation formatting guidance.",
      },
    ],
    decreeExamples: [
      "Audit recruiting Phase III CAR-T oncology trials on ClinicalTrials.gov and summarize FDA safety events.",
      "Compare recent PubMed literature and OpenFDA adverse-event profiles for GLP-1 receptor agonists.",
    ],
    goals: [
      {
        id: "gol_clin_ev",
        title: "Cross-Reference Trial & Literature Provenance",
        detail: "Index active ClinicalTrials.gov studies alongside recent peer-reviewed PubMed records.",
        status: "active",
        progress: 33,
        expectedRevenueCents: 3500,
      },
      {
        id: "gol_clin_safety",
        title: "Audit Pharmacovigilance Signals",
        detail: "Query OpenFDA FAERS reports and validate adverse-event counts with zero hallucination.",
        status: "active",
        progress: 0,
        expectedRevenueCents: 0,
      },
    ],
    tasks: [
      {
        id: "tsk_clin_trials",
        goalId: "gol_clin_ev",
        title: "Query PubMed & ClinicalTrials.gov for active Phase II/III studies",
        detail: "Pull NCT numbers, phase status, enrollment targets, and recent PubMed PMIDs.",
        status: "running",
        assignee: "Clinical-Evidence-Scout",
        role: "clinical-research",
        dependsOn: [],
      },
      {
        id: "tsk_clin_fda",
        goalId: "gol_clin_safety",
        title: "Scan OpenFDA FAERS database for adverse reaction telemetry",
        detail: "Aggregate serious vs non-serious FAERS event frequencies for target compound.",
        status: "pending",
        assignee: "Pharmacovigilance-Analyst",
        role: "pharmacovigilance",
        dependsOn: ["tsk_clin_trials"],
      },
      {
        id: "tsk_clin_audit",
        goalId: "gol_clin_ev",
        title: "Verify trial citations & compile regulated evidence brief",
        detail: "Audit PMID/NCT integrity and record verified summary.",
        status: "pending",
        assignee: "Verification-Auditor-01",
        role: "verification",
        dependsOn: ["tsk_clin_fda"],
      },
    ],
    workQueue: [
      {
        id: "wrk_biomed_tri",
        source: "clinical_ops",
        payload: { task: "synthesize_pubmed_and_nct_trials", topic: "GLP-1 cardiovascular outcomes" },
        acceptancePredicate: "result.studiesCount >= 2 && result.pmidsCount >= 2",
        priority: 95,
      },
      {
        id: "wrk_biomed_fda",
        source: "pharmacovigilance",
        payload: { task: "openfda_signal_check", compound: "semaglutide" },
        acceptancePredicate: "result.eventsAnalyzed >= 1",
        priority: 85,
      },
    ],
    peers: [
      { id: "pr_pubmed", name: "NCBI PubMed API", handle: "eutils.ncbi.nlm.nih.gov", note: "Live biomedical literature index active." },
      { id: "pr_ctgov", name: "ClinicalTrials.gov v2", handle: "clinicaltrials.gov", note: "Live interventional study registry active." },
      { id: "pr_fda", name: "OpenFDA FAERS", handle: "api.fda.gov", note: "Pharmacovigilance adverse event feed active." },
    ],
  },
  {
    id: "climate_geospatial",
    name: "Climate, Grid & Geospatial Ops",
    shortLabel: "Climate & Geo",
    sectorTag: "GEOSPATIAL & HAZARD TELEMETRY",
    summary:
      "Real-time USGS seismic hazard feeds, Open-Meteo meteorological & wind telemetry, and geospatial infrastructure grounding for dispatch readiness.",
    defaultFocus: "Pacific Coast seismic & wind grid resilience",
    missionTitle: "Live Seismic, Weather & Critical Infrastructure Readiness",
    missionObjective:
      "Monitor real-time USGS earthquake alerts, Open-Meteo wind/precipitation conditions, and geospatial infrastructure proximity to issue rapid dispatch plans.",
    missionPlanSummary:
      "Geo-Telemetry Mesh: Geospatial-Hazard-Scout polls USGS GeoJSON & Open-Meteo telemetry, Grid-Telemetry-Analyst locates nearby emergency infrastructure via OSM geospatial grounding, and Dispatch-Coordinator-01 stages field response.",
    successCriteria:
      "Live USGS seismic feed and Open-Meteo weather metrics reconciled with concrete geospatial coordinates.",
    entelechy: {
      mission:
        "Maintain continuous situational awareness across seismic hazards, severe weather vectors, and critical infrastructure resilience.",
      riskPosture: "operational_resilience",
      confidence: 0.87,
      priorities: [
        "Verify exact lat/lng coordinates & timestamps",
        "Correlate wind/precipitation with grid corridors",
        "Use geospatial grounding for staging venues",
      ],
      avoid: [
        "Stale weather forecasts",
        "Fabricated seismic magnitudes",
        "Unvalidated coordinate projections",
      ],
      recommendation:
        "Cross-check USGS M4.0+ events against Open-Meteo surface wind gusts and local staging hubs before dispatching field crews.",
    },
    specialists: [
      {
        id: "agt_orchestrator",
        name: "Orchestrator-Prime",
        kind: "local",
        status: "healthy",
        role: "orchestrator",
        task: "Coordinating geospatial hazard watch & dispatch DAG",
        latencyMs: 34,
        fundedCents: 0,
        systemPrompt:
          "You are Orchestrator-Prime operating Climate, Grid & Geospatial Ops. Triage seismic hazards, severe weather telemetry, and local logistics staging.",
        capabilities: [
          "decompose_mission",
          "query_usgs_weather",
          "maps_grounding_research",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_geo_scout",
        name: "Geospatial-Hazard-Scout",
        kind: "openclaw",
        status: "healthy",
        role: "geospatial-hazard",
        task: "Polling USGS GeoJSON & Open-Meteo surface conditions",
        latencyMs: 118,
        fundedCents: 700,
        systemPrompt:
          "You are Geospatial-Hazard-Scout. Execute query_usgs_weather and maps_grounding_research to pinpoint recent seismic activity, surface wind gusts, and critical regional staging locations.",
        capabilities: [
          "query_usgs_weather",
          "maps_grounding_research",
          "analyze_url_context",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_grid_analyst",
        name: "Grid-Telemetry-Analyst",
        kind: "openclaw",
        status: "healthy",
        role: "grid-ops",
        task: "Evaluating regional wind load & substation exposure",
        latencyMs: 96,
        fundedCents: 600,
        systemPrompt:
          "You are Grid-Telemetry-Analyst. Correlate Open-Meteo wind speed and precipitation data with USGS seismic zones and synthesize risk scores for Dispatch-Coordinator-01.",
        capabilities: [
          "query_usgs_weather",
          "invoke_custom_tool",
          "complete_work_item",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_auditor",
        name: "Verification-Auditor-01",
        kind: "openclaw",
        status: "healthy",
        role: "verification",
        task: "Validating sensor timestamps & dispatch predicates",
        latencyMs: 85,
        fundedCents: 400,
        systemPrompt:
          "You are Verification-Auditor-01. Confirm that geospatial alerts carry verified USGS event IDs, exact lat/lng pairs, and current Open-Meteo timestamps.",
        capabilities: ["complete_work_item", "update_task_status", "check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_treasury",
        name: "Treasury-Governor-01",
        kind: "local",
        status: "healthy",
        role: "treasury",
        task: "Enforcing compute reserve during telemetry polling",
        latencyMs: 26,
        fundedCents: 0,
        systemPrompt: "You are Treasury-Governor-01 guarding reserve floors during continuous geospatial telemetry.",
        capabilities: ["check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
    ],
    tools: [
      {
        id: "tl_usgs_weather",
        name: "query_usgs_weather",
        category: "geospatial",
        kind: "builtin",
        description:
          "Query live USGS Earthquake GeoJSON feed and Open-Meteo real-time temperature/wind/precipitation telemetry.",
        inputSchema: {
          latitude: "number (e.g. 37.7749)",
          longitude: "number (e.g. -122.4194)",
          minMagnitude: "number (e.g. 2.5)",
        },
        configJson: {
          endpoints: [
            "https://earthquake.usgs.gov/fdsnws/event/1/query",
            "https://api.open-meteo.com/v1/forecast",
          ],
          liveExternal: true,
        },
        createdBy: "System",
      },
    ],
    connectors: [
      {
        id: "conn_usgs_sf",
        label: "USGS Quakes + Bay Area Meteo",
        toolName: "query_usgs_weather",
        endpointLabel: "earthquake.usgs.gov + api.open-meteo.com",
        description: "Live global M3.5+ seismic feed + San Francisco real-time wind/temp.",
        sampleArgs: { latitude: 37.7749, longitude: -122.4194, minMagnitude: 3.5 },
      },
      {
        id: "conn_usgs_tokyo",
        label: "USGS Quakes + Tokyo Meteo",
        toolName: "query_usgs_weather",
        endpointLabel: "earthquake.usgs.gov + api.open-meteo.com",
        description: "Live M4.0+ seismic feed + Tokyo Bay weather telemetry.",
        sampleArgs: { latitude: 35.6762, longitude: 139.6503, minMagnitude: 4.0 },
      },
    ],
    urlPresets: [
      {
        label: "USGS GeoJSON Feed Spec",
        url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
        prompt: "Document GeoJSON feature schema, magnitude alert thresholds, and tsunami flags.",
      },
      {
        label: "Open-Meteo Forecast API Docs",
        url: "https://open-meteo.com/en/docs",
        prompt: "List hourly wind gust, solar irradiance, and severe weather code parameters.",
      },
    ],
    decreeExamples: [
      "Evaluate M3.5+ USGS seismic activity and surface wind conditions around San Francisco Bay substations.",
      "Use geospatial grounding to locate emergency staging hubs near Seattle and pair with Open-Meteo weather.",
    ],
    goals: [
      {
        id: "gol_geo_hazard",
        title: "Continuous Seismic & Weather Telemetry",
        detail: "Poll USGS GeoJSON events and Open-Meteo surface wind/precipitation in real time.",
        status: "active",
        progress: 25,
        expectedRevenueCents: 3000,
      },
      {
        id: "gol_geo_staging",
        title: "Verify Regional Logistics & Infrastructure",
        detail: "Ground regional power/emergency staging hubs with OpenStreetMap geospatial coordinates.",
        status: "active",
        progress: 0,
        expectedRevenueCents: 0,
      },
    ],
    tasks: [
      {
        id: "tsk_geo_poll",
        goalId: "gol_geo_hazard",
        title: "Ingest live USGS M3.5+ seismic events & Open-Meteo conditions",
        detail: "Fetch current hazard GeoJSON and surface wind telemetry.",
        status: "running",
        assignee: "Geospatial-Hazard-Scout",
        role: "geospatial-hazard",
        dependsOn: [],
      },
      {
        id: "tsk_geo_grid",
        goalId: "gol_geo_staging",
        title: "Correlate wind telemetry with regional infrastructure staging",
        detail: "Evaluate wind load exposure and identify staging points via geospatial grounding.",
        status: "pending",
        assignee: "Grid-Telemetry-Analyst",
        role: "grid-ops",
        dependsOn: ["tsk_geo_poll"],
      },
      {
        id: "tsk_geo_verify",
        goalId: "gol_geo_hazard",
        title: "Verify coordinate timestamps & issue operational readiness log",
        detail: "Audit sensor timestamps and publish verified situational report.",
        status: "pending",
        assignee: "Verification-Auditor-01",
        role: "verification",
        dependsOn: ["tsk_geo_grid"],
      },
    ],
    workQueue: [
      {
        id: "wrk_geo_watch",
        source: "telemetry_watch",
        payload: { task: "poll_usgs_and_open_meteo", latitude: 37.7749, longitude: -122.4194 },
        acceptancePredicate: "result.earthquakesScanned >= 1 && result.weatherRecorded === true",
        priority: 92,
      },
    ],
    peers: [
      { id: "pr_usgs", name: "USGS Seismic API", handle: "earthquake.usgs.gov", note: "Live GeoJSON earthquake stream active." },
      { id: "pr_meteo", name: "Open-Meteo Grid", handle: "api.open-meteo.com", note: "Real-time meteorological model feed active." },
    ],
  },
  {
    id: "finance_secops",
    name: "Macro Finance & SecOps Risk",
    shortLabel: "Fin & SecOps",
    sectorTag: "TREASURY MACRO & CVE INTEL",
    summary:
      "Live NIST NVD CVE 2.0 vulnerability intelligence, OSV dependency risk checks, and U.S. Treasury Fiscal Data macro liquidity monitoring.",
    defaultFocus: "critical infrastructure OpenSSL and TypeScript supply-chain CVEs",
    missionTitle: "CVE Vulnerability Triage & Macro Treasury Risk Audit",
    missionObjective:
      "Scan NIST NVD CVE 2.0 advisories for critical CVSS exposures while tracking U.S. Treasury Fiscal Data liquidity metrics to govern operational risk posture.",
    missionPlanSummary:
      "RiskMesh Architecture: Threat-Intel-Hunter sweeps NIST NVD CVE 2.0 & OSV advisories, Macro-Treasury-Quant monitors Treasury Fiscal Data, and Verification-Auditor-01 signs off patch & reserve posture.",
    successCriteria:
      "Live CVE IDs with CVSS scores and latest Treasury Fiscal Data record dates reconciled without speculation.",
    entelechy: {
      mission:
        "Enforce zero-trust dependency hygiene and macro-liquidity discipline through verifiable CVE and Treasury telemetry.",
      riskPosture: "zero_trust_risk",
      confidence: 0.91,
      priorities: [
        "Triage CVSS >= 7.0 advisories immediately",
        "Anchor macro briefs to U.S. Treasury record dates",
        "Cross-verify remediation advisories",
      ],
      avoid: [
        "Ignoring high-severity CVEs",
        "Unverified market price speculation",
        "Bypassing PolicyEngine transfer caps",
      ],
      recommendation:
        "Pair NIST NVD keyword sweeps with URL Context inspection of official vendor security advisories.",
    },
    specialists: [
      {
        id: "agt_orchestrator",
        name: "Orchestrator-Prime",
        kind: "local",
        status: "healthy",
        role: "orchestrator",
        task: "Coordinating CVE risk sweeps & macro treasury audit",
        latencyMs: 35,
        fundedCents: 0,
        systemPrompt:
          "You are Orchestrator-Prime in Macro Finance & SecOps Risk mode. Route CVE intelligence and Treasury liquidity checks across Threat-Intel-Hunter and Macro-Treasury-Quant.",
        capabilities: [
          "decompose_mission",
          "query_nvd_cves",
          "check_treasury",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_threat_hunter",
        name: "Threat-Intel-Hunter",
        kind: "openclaw",
        status: "healthy",
        role: "secops",
        task: "Querying NIST NVD CVE 2.0 & advisory feeds",
        latencyMs: 134,
        fundedCents: 800,
        systemPrompt:
          "You are Threat-Intel-Hunter. Use query_nvd_cves and analyze_url_context to identify high/critical CVEs, affected software versions, and mitigation steps.",
        capabilities: [
          "query_nvd_cves",
          "analyze_url_context",
          "search_github_repos",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_macro_quant",
        name: "Macro-Treasury-Quant",
        kind: "openclaw",
        status: "healthy",
        role: "macro-finance",
        task: "Auditing U.S. Treasury Fiscal Data & reserve posture",
        latencyMs: 105,
        fundedCents: 600,
        systemPrompt:
          "You are Macro-Treasury-Quant. Inspect U.S. Treasury Fiscal Data records via query_nvd_cves / fetch_public_endpoint and reconcile internal credit reserve telemetry.",
        capabilities: [
          "query_nvd_cves",
          "check_treasury",
          "complete_work_item",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_auditor",
        name: "Verification-Auditor-01",
        kind: "openclaw",
        status: "healthy",
        role: "verification",
        task: "Validating CVE IDs, CVSS scores & compliance gates",
        latencyMs: 92,
        fundedCents: 400,
        systemPrompt:
          "You are Verification-Auditor-01. Verify exact CVE-YYYY-NNNN identifiers, CVSS scores, and Treasury record dates before completing tasks.",
        capabilities: ["complete_work_item", "update_task_status", "check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_treasury",
        name: "Treasury-Governor-01",
        kind: "local",
        status: "healthy",
        role: "treasury",
        task: "Enforcing capital floor & transfer policy limits",
        latencyMs: 25,
        fundedCents: 0,
        systemPrompt: "You are Treasury-Governor-01 overseeing strict reserve floor compliance.",
        capabilities: ["check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
    ],
    tools: [
      {
        id: "tl_nvd_cves",
        name: "query_nvd_cves",
        category: "secops",
        kind: "builtin",
        description:
          "Query live NIST NVD CVE 2.0 vulnerability API and U.S. Treasury Fiscal Data Debt-to-the-Penny endpoint.",
        inputSchema: { query: "string (software or CVE keyword)", maxResults: "number (1-8)" },
        configJson: {
          endpoints: [
            "https://services.nvd.nist.gov/rest/json/cves/2.0",
            "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny",
          ],
          liveExternal: true,
        },
        createdBy: "System",
      },
    ],
    connectors: [
      {
        id: "conn_nvd_openssl",
        label: "NIST NVD CVEs + US Treasury",
        toolName: "query_nvd_cves",
        endpointLabel: "services.nvd.nist.gov + api.fiscaldata.treasury.gov",
        description: "Fetch live OpenSSL/Node CVEs alongside recent U.S. Treasury daily debt ledger.",
        sampleArgs: { query: "openssl", maxResults: 4 },
      },
      {
        id: "conn_nvd_postgres",
        label: "NVD Postgres Advisories",
        toolName: "query_nvd_cves",
        endpointLabel: "services.nvd.nist.gov/rest/json/cves/2.0",
        description: "Audit recent PostgreSQL CVE disclosures & CVSS v3 severity.",
        sampleArgs: { query: "postgresql", maxResults: 4 },
      },
    ],
    urlPresets: [
      {
        label: "CISA Known Exploited Vulns Catalog",
        url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
        prompt: "Extract guidance on KEV remediation deadlines and active exploitation reporting.",
      },
      {
        label: "U.S. Treasury Fiscal Data Portal",
        url: "https://fiscaldata.treasury.gov/api-documentation/",
        prompt: "Summarize Treasury Fiscal Data API pagination, sort fields, and debt_to_penny endpoints.",
      },
    ],
    decreeExamples: [
      "Sweep NIST NVD for recent PostgreSQL and Node.js CVEs and assess patch urgency.",
      "Reconcile latest U.S. Treasury Fiscal Data ledger dates alongside internal compute reserve tiers.",
    ],
    goals: [
      {
        id: "gol_sec_cve",
        title: "Zero-Trust CVE Vulnerability Surveillance",
        detail: "Query NIST NVD CVE 2.0 continuously for runtime, database, and dependency vulnerabilities.",
        status: "active",
        progress: 33,
        expectedRevenueCents: 4500,
      },
      {
        id: "gol_sec_macro",
        title: "Macro Fiscal & Treasury Telemetry",
        detail: "Track live U.S. Treasury Fiscal Data records and internal PolicyEngine compliance.",
        status: "active",
        progress: 0,
        expectedRevenueCents: 0,
      },
    ],
    tasks: [
      {
        id: "tsk_sec_nvd",
        goalId: "gol_sec_cve",
        title: "Sweep NIST NVD CVE 2.0 for critical infrastructure disclosures",
        detail: "Inspect CVE IDs, published dates, and CVSS severity scores.",
        status: "running",
        assignee: "Threat-Intel-Hunter",
        role: "secops",
        dependsOn: [],
      },
      {
        id: "tsk_sec_macro",
        goalId: "gol_sec_macro",
        title: "Audit U.S. Treasury Fiscal Data & reserve floor posture",
        detail: "Confirm latest Treasury reporting date and validate 10.00 cr reserve compliance.",
        status: "pending",
        assignee: "Macro-Treasury-Quant",
        role: "macro-finance",
        dependsOn: ["tsk_sec_nvd"],
      },
      {
        id: "tsk_sec_signoff",
        goalId: "gol_sec_cve",
        title: "Verify CVE remediation list & publish risk brief",
        detail: "Confirm CVE provenance before signing off security posture.",
        status: "pending",
        assignee: "Verification-Auditor-01",
        role: "verification",
        dependsOn: ["tsk_sec_macro"],
      },
    ],
    workQueue: [
      {
        id: "wrk_sec_cve",
        source: "secops_watch",
        payload: { task: "triage_nvd_cve_stream", keyword: "openssl" },
        acceptancePredicate: "result.cvesEvaluated >= 2 && result.treasuryChecked === true",
        priority: 96,
      },
    ],
    peers: [
      { id: "pr_nvd", name: "NIST NVD CVE 2.0", handle: "services.nvd.nist.gov", note: "Live federal vulnerability feed active." },
      { id: "pr_treas", name: "US Treasury Fiscal API", handle: "api.fiscaldata.treasury.gov", note: "Daily public debt & fiscal dataset active." },
    ],
  },
  {
    id: "policy_supply",
    name: "Civic Policy & Supply Chain Briefing",
    shortLabel: "Policy & Supply",
    sectorTag: "REGULATORY & EXECUTIVE BRIEFING",
    summary:
      "Live Federal Register rulemaking tracker, OpenAlex scholarly & industrial supply-chain graph, deep URL Context ingestion, and spoken executive audio briefings.",
    defaultFocus: "semiconductor export controls and supply chain resilience",
    missionTitle: "Regulatory Intelligence & Executive Audio Briefing Pipeline",
    missionObjective:
      "Track live Federal Register notices and OpenAlex policy research, distill primary web documents via URL Context, and publish an executive TTS briefing.",
    missionPlanSummary:
      "Policy Briefing Mesh: Regulatory-Policy-Analyst monitors Federal Register filings, Supply-Chain-Router correlates OpenAlex industrial papers, and Briefing-Synthesizer-01 compiles audio-ready dossiers.",
    successCriteria:
      "Verified Federal Register document numbers and OpenAlex citations archived in semantic Domain Memory.",
    entelechy: {
      mission:
        "Deliver crisp, citation-backed regulatory and supply-chain intelligence ready for executive voice briefing.",
      riskPosture: "compliance_advisory",
      confidence: 0.86,
      priorities: [
        "Cite Federal Register document numbers & effective dates",
        "Index primary sources into Semantic Domain Memory",
        "Produce clear executive audio summaries",
      ],
      avoid: [
        "Legal advice assertions",
        "Undated policy summaries",
        "Omitting agency attribution",
      ],
      recommendation:
        "Combine Federal Register live API queries with NVIDIA NIM URL Context digestion on agency fact sheets, then synthesize an executive audio brief.",
    },
    specialists: [
      {
        id: "agt_orchestrator",
        name: "Orchestrator-Prime",
        kind: "local",
        status: "healthy",
        role: "orchestrator",
        task: "Coordinating regulatory monitoring & briefing DAG",
        latencyMs: 36,
        fundedCents: 0,
        systemPrompt:
          "You are Orchestrator-Prime leading Civic Policy & Supply Chain Briefing. Coordinate Federal Register tracking, OpenAlex policy synthesis, and URL Context indexing.",
        capabilities: [
          "decompose_mission",
          "query_federal_register",
          "analyze_url_context",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_policy_analyst",
        name: "Regulatory-Policy-Analyst",
        kind: "openclaw",
        status: "healthy",
        role: "policy-analyst",
        task: "Monitoring Federal Register filings & agency notices",
        latencyMs: 121,
        fundedCents: 700,
        systemPrompt:
          "You are Regulatory-Policy-Analyst. Query Federal Register public documents and analyze agency URLs to surface concrete rule dates, agencies, and compliance deadlines.",
        capabilities: [
          "query_federal_register",
          "analyze_url_context",
          "web_grounding_research",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_supply_router",
        name: "Supply-Chain-Router",
        kind: "openclaw",
        status: "healthy",
        role: "supply-chain",
        task: "Correlating OpenAlex industrial & logistics literature",
        latencyMs: 108,
        fundedCents: 600,
        systemPrompt:
          "You are Supply-Chain-Router. Cross-reference Federal Register rulings with OpenAlex research works and prepare structured briefing points.",
        capabilities: [
          "query_federal_register",
          "maps_grounding_research",
          "complete_work_item",
          "handoff_to_agent",
        ],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_auditor",
        name: "Verification-Auditor-01",
        kind: "openclaw",
        status: "healthy",
        role: "verification",
        task: "Auditing Federal Register doc numbers & source dates",
        latencyMs: 90,
        fundedCents: 400,
        systemPrompt:
          "You are Verification-Auditor-01. Confirm every regulatory brief includes exact document numbers, publication dates, and agency names.",
        capabilities: ["complete_work_item", "update_task_status", "check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
      {
        id: "agt_treasury",
        name: "Treasury-Governor-01",
        kind: "local",
        status: "healthy",
        role: "treasury",
        task: "Monitoring reserve floor & TTS briefing spend",
        latencyMs: 27,
        fundedCents: 0,
        systemPrompt: "You are Treasury-Governor-01 maintaining reserve floor integrity.",
        capabilities: ["check_treasury", "handoff_to_agent"],
        autonomyLevel: "autonomous",
      },
    ],
    tools: [
      {
        id: "tl_fed_reg",
        name: "query_federal_register",
        category: "policy",
        kind: "builtin",
        description:
          "Query live U.S. Federal Register public filings API and OpenAlex scholarly policy graph simultaneously.",
        inputSchema: { query: "string", maxResults: "number (1-8)" },
        configJson: {
          endpoints: [
            "https://www.federalregister.gov/api/v1/documents.json",
            "https://api.openalex.org/works",
          ],
          liveExternal: true,
        },
        createdBy: "System",
      },
    ],
    connectors: [
      {
        id: "conn_fedreg_ai",
        label: "Federal Register + OpenAlex",
        toolName: "query_federal_register",
        endpointLabel: "federalregister.gov/api/v1 + api.openalex.org",
        description: "Pull live federal rules/notices alongside OpenAlex policy & supply-chain research.",
        sampleArgs: { query: "semiconductor supply chain", maxResults: 4 },
      },
      {
        id: "conn_fedreg_energy",
        label: "Energy Grid & Tariffs",
        toolName: "query_federal_register",
        endpointLabel: "federalregister.gov/api/v1/documents.json",
        description: "Inspect recent Federal Register notices on grid transmission and critical minerals.",
        sampleArgs: { query: "critical minerals grid", maxResults: 4 },
      },
    ],
    urlPresets: [
      {
        label: "Federal Register Developer API",
        url: "https://www.federalregister.gov/developers/documentation/api/v1",
        prompt: "Extract available document filter parameters, agency slugs, and docket metadata fields.",
      },
      {
        label: "OpenAlex Works API Reference",
        url: "https://docs.openalex.org/api-entities/works",
        prompt: "Summarize search filters, citation counts, and open-access URL fields.",
      },
    ],
    decreeExamples: [
      "Track Federal Register notices on semiconductor export rules and generate an executive briefing.",
      "Analyze grid transmission policy filings and cross-reference OpenAlex supply-chain studies.",
    ],
    goals: [
      {
        id: "gol_pol_track",
        title: "Live Federal Rulemaking Surveillance",
        detail: "Index recent Federal Register notices with agency attribution and docket dates.",
        status: "active",
        progress: 33,
        expectedRevenueCents: 3200,
      },
      {
        id: "gol_pol_brief",
        title: "Semantic Dossier & Audio Briefing",
        detail: "Persist policy findings into semantic memory for cross-domain executive audio briefings.",
        status: "active",
        progress: 0,
        expectedRevenueCents: 0,
      },
    ],
    tasks: [
      {
        id: "tsk_pol_reg",
        goalId: "gol_pol_track",
        title: "Query Federal Register API for active notices & rules",
        detail: "Fetch document numbers, agencies, and publication dates.",
        status: "running",
        assignee: "Regulatory-Policy-Analyst",
        role: "policy-analyst",
        dependsOn: [],
      },
      {
        id: "tsk_pol_oa",
        goalId: "gol_pol_brief",
        title: "Correlate OpenAlex industrial & supply-chain literature",
        detail: "Pair rulemaking findings with peer-reviewed logistics research.",
        status: "pending",
        assignee: "Supply-Chain-Router",
        role: "supply-chain",
        dependsOn: ["tsk_pol_reg"],
      },
      {
        id: "tsk_pol_audit",
        goalId: "gol_pol_track",
        title: "Verify citation dates & ready executive audio dossier",
        detail: "Audit agency doc numbers prior to TTS briefing synthesis.",
        status: "pending",
        assignee: "Verification-Auditor-01",
        role: "verification",
        dependsOn: ["tsk_pol_oa"],
      },
    ],
    workQueue: [
      {
        id: "wrk_pol_digest",
        source: "policy_watch",
        payload: { task: "federal_register_supply_digest", query: "semiconductor supply chain" },
        acceptancePredicate: "result.documentsCount >= 2 && result.worksCount >= 2",
        priority: 90,
      },
    ],
    peers: [
      { id: "pr_fedreg", name: "Federal Register v1", handle: "www.federalregister.gov", note: "Live U.S. regulatory filings feed active." },
      { id: "pr_openalex", name: "OpenAlex Graph API", handle: "api.openalex.org", note: "Scholarly & policy citation graph active." },
    ],
  },
];

export function isValidDomainId(value: string): value is DomainId {
  return DOMAIN_PACKS.some((d) => d.id === value);
}

export function listDomainPacks(): DomainPack[] {
  return [...DOMAIN_PACKS];
}

export function getDomainPack(domainId?: string | null): DomainPack {
  if (domainId && isValidDomainId(domainId)) {
    return DOMAIN_PACKS.find((d) => d.id === domainId)!;
  }
  return DOMAIN_PACKS[0]!;
}

export interface DomainActivationPlan {
  pack: DomainPack;
  missionId: string;
  missionTitle: string;
  missionObjective: string;
  goals: Array<DomainGoalBlueprint>;
  tasks: Array<DomainTaskBlueprint & { createdAt: number }>;
  workQueue: Array<DomainWorkBlueprint & { createdAt: number }>;
  specialists: DomainSpecialistSpec[];
  peers: DomainPeerBlueprint[];
  entelechy: DomainPack["entelechy"];
}

/**
 * Deterministically build an activation plan when switching Cletus into a new operational domain.
 * Guarantees an acyclic task dependency graph.
 */
export function buildDomainActivationPlan(
  domainId: DomainId,
  customFocus?: string,
  now = Date.now(),
): DomainActivationPlan {
  const pack = getDomainPack(domainId);
  const focus = customFocus?.trim();
  const suffix = `${domainId}_${now.toString(36).slice(-4)}`;
  const missionId = `msn_${suffix}`;

  const missionTitle = focus ? `${pack.shortLabel}: ${focus.slice(0, 68)}` : pack.missionTitle;
  const missionObjective = focus
    ? `${pack.missionObjective} Primary operator focus: ${focus}.`
    : pack.missionObjective;

  const goalIdMap = new Map<string, string>();
  const goals = pack.goals.map((g, idx) => {
    const id = `gol_${suffix}_${idx + 1}`;
    goalIdMap.set(g.id, id);
    return {
      ...g,
      id,
      status: "active" as const,
    };
  });

  const taskIdMap = new Map<string, string>();
  pack.tasks.forEach((t, idx) => {
    taskIdMap.set(t.id, `tsk_${suffix}_${idx + 1}`);
  });

  const tasks: Array<DomainTaskBlueprint & { createdAt: number }> = [];
  const runningSoFar: Task[] = [];

  pack.tasks.forEach((t, idx) => {
    const id = taskIdMap.get(t.id)!;
    const goalId = goalIdMap.get(t.goalId) ?? goals[0]!.id;
    const dependsOn = t.dependsOn.map((d) => taskIdMap.get(d) ?? d);
    const candidate: Task = {
      id,
      goalId,
      title: focus && idx === 0 ? `${t.title} [${focus.slice(0, 36)}]` : t.title,
      detail: t.detail,
      status: idx === 0 ? "running" : "pending",
      assignee: t.assignee,
      role: t.role,
      dependsOn,
      createdAt: now + idx,
    };
    if (wouldCreateTaskCycle(runningSoFar, id, dependsOn)) {
      throw new Error(`Domain pack ${domainId} contains cyclic task dependency at ${t.id}`);
    }
    runningSoFar.push(candidate);
    tasks.push({
      id: candidate.id,
      goalId: candidate.goalId,
      title: candidate.title,
      detail: candidate.detail ?? "",
      status: candidate.status,
      assignee: candidate.assignee,
      role: candidate.role,
      dependsOn: candidate.dependsOn,
      createdAt: now + idx,
    });
  });

  const workQueue = pack.workQueue.map((w, idx) => ({
    ...w,
    id: `wrk_${suffix}_${idx + 1}`,
    payload: focus ? { ...w.payload, focus } : w.payload,
    createdAt: now + idx,
  }));

  return {
    pack,
    missionId,
    missionTitle,
    missionObjective,
    goals,
    tasks,
    workQueue,
    specialists: pack.specialists,
    peers: pack.peers,
    entelechy: focus
      ? {
          ...pack.entelechy,
          mission: `${pack.entelechy.mission} Active focus: ${focus}.`,
        }
      : pack.entelechy,
  };
}

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function lexicalScore(query: string, text: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let matched = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) matched += 1;
  }
  return matched / tokens.length;
}

export interface RankedMemoryResult {
  item: DomainMemoryItem;
  score: number;
  matchKind: "semantic" | "lexical";
}

export function rankDomainMemories(
  items: ReadonlyArray<{ item: DomainMemoryItem; embedding?: number[] | null }>,
  query: string,
  queryEmbedding?: ReadonlyArray<number> | null,
): RankedMemoryResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items.map(({ item }) => ({
      item,
      score: 1,
      matchKind: item.hasEmbedding ? "semantic" : "lexical",
    }));
  }

  const ranked = items.map(({ item, embedding }) => {
    const textBlob = `${item.title} ${item.summary} ${item.tags.join(" ")} ${item.sourceUrl ?? ""}`;
    const lex = lexicalScore(trimmed, textBlob);
    if (
      queryEmbedding &&
      queryEmbedding.length > 0 &&
      embedding &&
      embedding.length === queryEmbedding.length
    ) {
      const cos = Math.max(0, cosineSimilarity(queryEmbedding, embedding));
      return {
        item,
        score: Number((cos * 0.78 + lex * 0.22).toFixed(4)),
        matchKind: "semantic" as const,
      };
    }
    return {
      item,
      score: Number(lex.toFixed(4)),
      matchKind: "lexical" as const,
    };
  });

  return ranked
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
}
