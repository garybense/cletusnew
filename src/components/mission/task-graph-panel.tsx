import { useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Clock,
  Columns2,
  Compass,
  Cpu,
  Film,
  GitBranch,
  Globe,
  History,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { computeTaskMetadata } from "@/lib/cletus/d3-graph";
import {
  childStatusLabel,
  childTone,
  formatAgo,
  formatCents,
  normalizeTaskPriority,
  taskPriorityBadgeClass,
  taskPriorityLabel,
  taskStatusLabel,
  toneTextClass,
} from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import type { Task, TaskPriority, TaskStatus } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { D3TaskGraph } from "./d3-task-graph";
import { D3TaskTimeline } from "./d3-task-timeline";
import { DomainStudioPanel } from "./domain-studio-panel";
import { EvolutionPanel } from "./evolution-panel";
import { FleetCensus } from "./fleet-census";
import { GroundingPanel } from "./grounding-panel";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";
import { TaskChecklist } from "./task-checklist";
import { VideoStudioPanel } from "./video-studio-panel";

type LeftMode = "graph" | "evolution" | "domains" | "fleet" | "census" | "cycles" | "tools" | "grounding" | "video";
type GraphSplitMode = "split" | "graph" | "list";

function formatShortTimestamp(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${d.toISOString().slice(11, 19)} UTC`;
}

function formatDurationCompact(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const sec = Math.floor(ms / 1_000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

const STATUS_OPTIONS: TaskStatus[] = ["pending", "assigned", "running", "completed", "failed"];
const PRIORITY_OPTIONS: TaskPriority[] = ["low", "medium", "high"];

export function TaskGraphPanel() {
  const missions = useMissionField((s) => s.missions);
  const goals = useMissionField((s) => s.goals);
  const tasks = useMissionField((s) => s.tasks);
  const taskEvents = useMissionField((s) => s.taskEvents);
  const vitals = useMissionField((s) => s.vitals);
  const children = useMissionField((s) => s.children);
  const peers = useMissionField((s) => s.peers);
  const cycles = useMissionField((s) => s.cycles);
  const spendByModel = useMissionField((s) => s.spendByModel);
  const toolSpends = useMissionField((s) => s.toolSpends);
  const agentMessages = useMissionField((s) => s.agentMessages);
  const tools = useMissionField((s) => s.tools);
  const evolutionSummary = useMissionField((s) => s.evolutionSummary);
  const now = useMissionClock();

  const selectedNode = useCletusStore((s) => s.selectedNode);
  const setSelectedNode = useCletusStore((s) => s.setSelectedNode);
  const addTask = useCletusStore((s) => s.addTask);
  const updateTask = useCletusStore((s) => s.updateTask);
  const reorderTasks = useCletusStore((s) => s.reorderTasks);
  const controlMission = useCletusStore((s) => s.controlMission);
  const pingWorker = useCletusStore((s) => s.pingWorker);
  const configureAgent = useCletusStore((s) => s.configureAgent);
  const synthesizeTool = useCletusStore((s) => s.synthesizeTool);
  const testTool = useCletusStore((s) => s.testTool);
  const runTurn = useCletusStore((s) => s.runTurn);
  const lastToolOutput = useCletusStore((s) => s.lastToolOutput);
  const loading = useCletusStore((s) => s.loading);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [mode, setMode] = useState<LeftMode>("graph");
  const [graphSplitMode, setGraphSplitMode] = useState<GraphSplitMode>("split");
  const [showTimeline, setShowTimeline] = useState<boolean>(false);
  const [goalFilter, setGoalFilter] = useState<string>("all");
  const [missionOnly, setMissionOnly] = useState<boolean>(false);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showAddTool, setShowAddTool] = useState(false);

  // Add Task state
  const [newGoalId, setNewGoalId] = useState("gol_bounty");
  const [newTitle, setNewTitle] = useState("");
  const [newDetail, setNewDetail] = useState("");
  const [newPriority, setNewPriority] = useState<TaskPriority>("medium");
  const [newAssignee, setNewAssignee] = useState("Orchestrator-Prime");
  const [newRole, setNewRole] = useState("orchestrator");
  const [newDepId, setNewDepId] = useState("");

  // Add/Configure Agent state
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("specialist");
  const [agentPrompt, setAgentPrompt] = useState(
    "Execute assigned research/engineering steps concisely using live tools and structured handoffs.",
  );
  const [agentCaps, setAgentCaps] = useState("search_arxiv, search_github_repos, handoff_to_agent");

  // Synthesize Tool state
  const [toolName, setToolName] = useState("");
  const [toolCat, setToolCat] = useState("research");
  const [toolKind, setToolKind] = useState<"http_json" | "nvidia_analyzer">("http_json");
  const [toolDesc, setToolDesc] = useState("");
  const [toolUrlTpl, setToolUrlTpl] = useState(
    "https://api.semanticscholar.org/graph/v1/paper/search?query={{query}}&limit=3",
  );
  const [toolPromptTpl, setToolPromptTpl] = useState(
    "Analyze the input specification and return concrete verifiable findings.",
  );

  // Live tool runner state
  const [activeToolName, setActiveToolName] = useState("search_arxiv");
  const [toolArgsJson, setToolArgsJson] = useState('{"query":"multi-agent dynamic role assignment","maxResults":3}');

  const selectedMission =
    selectedNode?.kind === "mission" ? missions.find((m) => m.id === selectedNode.id) : undefined;
  const selectedGoal =
    selectedNode?.kind === "goal" ? goals.find((g) => g.id === selectedNode.id) : undefined;
  const selectedTask =
    selectedNode?.kind === "task" ? tasks.find((t) => t.id === selectedNode.id) : undefined;
  const selectedWorker =
    selectedNode?.kind === "worker"
      ? children.find(
          (c) => c.id === selectedNode.id || c.name.toLowerCase() === selectedNode.id.toLowerCase(),
        )
      : undefined;

  const selectedTaskMeta = useMemo(
    () =>
      selectedTask
        ? computeTaskMetadata(selectedTask, {
            tasks,
            goals,
            missions,
            children,
            cycles,
            spendByModel,
            toolSpends,
            agentMessages,
            taskEvents,
            now,
          })
        : null,
    [selectedTask, tasks, goals, missions, children, cycles, spendByModel, toolSpends, agentMessages, taskEvents, now],
  );

  async function handleAddTask(e: FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const res = await addTask({
      goalId: newGoalId || goals[0]?.id || "gol_bounty",
      title: newTitle.trim(),
      detail: newDetail.trim() || undefined,
      priority: newPriority,
      assignee: newAssignee.trim() || "Orchestrator-Prime",
      role: newRole.trim() || "specialist",
      dependsOn: newDepId ? [newDepId] : [],
    });
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create task node.");
      return;
    }
    toast.success("Task node persisted to Task DAG.");
    setNewTitle("");
    setNewDetail("");
    setNewPriority("medium");
    setNewDepId("");
    setShowAddTask(false);
  }

  async function handleStatusChange(taskId: string, nextStatus: TaskStatus) {
    setUpdatingTaskId(taskId);
    try {
      const res = await updateTask({
        id: taskId,
        status: nextStatus,
        result: nextStatus === "completed" ? "Marked completed via Task DAG inspector" : undefined,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Task transition blocked.");
        return;
      }
      toast.success(`Task ${taskId} → ${taskStatusLabel(nextStatus)}`);
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handlePriorityChange(taskId: string, nextPriority: TaskPriority) {
    setUpdatingTaskId(taskId);
    try {
      const res = await updateTask({
        id: taskId,
        priority: nextPriority,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Failed to update task priority.");
        return;
      }
      toast.success(`Task ${taskId} priority → ${taskPriorityLabel(nextPriority)}`);
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handleToggleTaskComplete(task: Task) {
    const nextStatus: TaskStatus = task.status === "completed" ? "assigned" : "completed";
    setUpdatingTaskId(task.id);
    try {
      const res = await updateTask({
        id: task.id,
        status: nextStatus,
        result:
          nextStatus === "completed"
            ? task.result || "Marked completed via Task List"
            : undefined,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Task status update blocked by unmet dependencies.");
        return;
      }
      toast.success(
        nextStatus === "completed"
          ? `Task "${task.title}" completed — D3 dependency graph updated.`
          : `Task "${task.title}" reopened — D3 dependency graph updated.`,
      );
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handleReorderTasks(orderedIds: string[]) {
    const res = await reorderTasks(orderedIds);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to persist task order.");
      return;
    }
    toast.success("Task sequence saved to database & D3 graph.");
  }

  async function handleSaveAgent(e: FormEvent) {
    e.preventDefault();
    if (!agentName.trim()) return;
    await configureAgent({
      agentName: agentName.trim(),
      role: agentRole.trim() || "specialist",
      systemPrompt: agentPrompt.trim(),
      capabilities: agentCaps
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    toast.success(`Configured specialist agent ${agentName.trim()}.`);
    setAgentName("");
    setShowAddAgent(false);
  }

  async function handleSaveTool(e: FormEvent) {
    e.preventDefault();
    if (!toolName.trim() || !toolDesc.trim()) return;
    await synthesizeTool({
      name: toolName.trim(),
      category: toolCat.trim() || "research",
      kind: toolKind,
      description: toolDesc.trim(),
      urlTemplate: toolKind === "http_json" ? toolUrlTpl.trim() : undefined,
      promptTemplate: toolKind === "nvidia_analyzer" ? toolPromptTpl.trim() : undefined,
    });
    toast.success(`Registered capability ${toolName.trim()} in Tool Forge.`);
    setToolName("");
    setToolDesc("");
    setShowAddTool(false);
  }

  async function handleRunToolTest(e: FormEvent) {
    e.preventDefault();
    const res = await testTool(activeToolName, toolArgsJson);
    if (res.ok) {
      toast.success(`Live execution of ${activeToolName} succeeded.`);
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  return (
    <section className="flex h-full min-h-[300px] flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Header Tabs */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-1.5 border-b border-border px-3 py-2">
        <div className="flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setMode("graph")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "graph"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <GitBranch className="size-3" />
            <span>Task DAG ({tasks.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("evolution")}
            aria-label={`Self-Evolution (${evolutionSummary.overallMaturity} maturity)`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "evolution"
                ? "bg-primary text-primary-foreground"
                : evolutionSummary.isIdle
                  ? "border border-ok/40 bg-ok/10 text-ok hover:bg-ok/20"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Cpu className="size-3" />
            <span>Evolution ({evolutionSummary.overallMaturity})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("domains")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "domains"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Compass className="size-3" />
            <span>Domains (5)</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("fleet")}
            aria-label={`Agent Mesh (${children.length})`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "fleet"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Users className="size-3" />
            <span>Mesh ({children.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("census")}
            aria-label={`Fleet Census (${1 + children.length + peers.length})`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "census"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Server className="size-3" />
            <span>Fleet ({1 + children.length + peers.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("cycles")}
            aria-label={`Cycles P-R-A-O (${cycles.length})`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "cycles"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Activity className="size-3" />
            <span>P-R-A-O ({cycles.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("tools")}
            aria-label={`Tool Forge (${tools.length})`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "tools"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Wrench className="size-3" />
            <span>Tools ({tools.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("grounding")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "grounding"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Globe className="size-3" />
            <span>Search &amp; Maps</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("video")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
              mode === "video"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Film className="size-3" />
            <span>Video Studio</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {mode === "graph" ? (
            <>
              <div className="flex items-center rounded border border-border bg-term p-0.5">
                <button
                  type="button"
                  onClick={() => setGraphSplitMode("split")}
                  aria-label="Split task list and D3 graph"
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded px-1.5 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                    graphSplitMode === "split"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Columns2 className="size-3" />
                  <span>Split</span>
                </button>
                <button
                  type="button"
                  onClick={() => setGraphSplitMode("graph")}
                  aria-label="D3 graph view only"
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded px-1.5 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                    graphSplitMode === "graph"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <GitBranch className="size-3" />
                  <span>D3 Graph</span>
                </button>
                <button
                  type="button"
                  onClick={() => setGraphSplitMode("list")}
                  aria-label="Task list view only"
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded px-1.5 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                    graphSplitMode === "list"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ListChecks className="size-3" />
                  <span>List</span>
                </button>
              </div>
              <button
                type="button"
                data-testid="toggle-task-timeline-btn"
                onClick={() => setShowTimeline((v) => !v)}
                aria-expanded={showTimeline}
                aria-label="Toggle historical task state timeline"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded border px-2 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                  showTimeline
                    ? "border-warn/60 bg-warn/15 text-warn"
                    : "border-border bg-term text-muted-foreground hover:text-foreground",
                )}
              >
                <History className="size-3" />
                <span>Timeline</span>
              </button>
              <button
                type="button"
                onClick={() => setMissionOnly((v) => !v)}
                className={cn(
                  "h-7 rounded border px-2 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                  missionOnly
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border bg-term text-muted-foreground hover:text-foreground",
                )}
              >
                {missionOnly ? "Mission Scope" : "All Tasks"}
              </button>
              <select
                aria-label="Filter graph by goal"
                value={goalFilter}
                onChange={(e) => setGoalFilter(e.target.value)}
                className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All Goals ({goals.length})</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title.slice(0, 28)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAddTask((v) => !v)}
                className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
              >
                <Plus className="size-3.5" />
                <span>{showAddTask ? "Cancel" : "Add Task"}</span>
              </Button>
            </>
          ) : mode === "fleet" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAddAgent((v) => !v)}
              className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
            >
              <Plus className="size-3.5" />
              <span>{showAddAgent ? "Cancel" : "Configure Role"}</span>
            </Button>
          ) : mode === "tools" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAddTool((v) => !v)}
              className="h-7 whitespace-nowrap shrink-0 px-2.5 text-xs"
            >
              <Plus className="size-3.5" />
              <span>{showAddTool ? "Cancel" : "Synthesize Tool"}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Inline Add Task Form */}
      {mode === "graph" && showAddTask ? (
        <form
          onSubmit={handleAddTask}
          className="flex-none border-b border-border bg-secondary/40 px-3 py-2.5 text-xs"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title (e.g. Synthesize arXiv benchmark query)"
              className="h-8 bg-term text-xs sm:col-span-2"
              required
            />
            <select
              aria-label="Parent goal"
              value={newGoalId}
              onChange={(e) => setNewGoalId(e.target.value)}
              className="h-8 rounded-md border border-border bg-term px-2 text-xs text-foreground"
            >
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title.slice(0, 30)}
                </option>
              ))}
            </select>
            <select
              aria-label="Assignee"
              value={newAssignee}
              onChange={(e) => setNewAssignee(e.target.value)}
              className="h-8 rounded-md border border-border bg-term px-2 text-xs text-foreground"
            >
              {children.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>
            <Input
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              placeholder="Role (e.g. research)"
              className="h-8 bg-term text-xs"
            />
            <select
              aria-label="Upstream dependency"
              value={newDepId}
              onChange={(e) => setNewDepId(e.target.value)}
              className="h-8 rounded-md border border-border bg-term px-2 text-xs text-foreground"
            >
              <option value="">No dependency</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  after {t.id} · {t.title.slice(0, 20)}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <select
              aria-label="Task priority"
              data-testid="add-task-priority-select"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
              className="h-8 rounded-md border border-border bg-term px-2 font-mono text-xs text-foreground"
            >
              <option value="low">Priority: Low</option>
              <option value="medium">Priority: Medium</option>
              <option value="high">Priority: High</option>
            </select>
            <Input
              value={newDetail}
              onChange={(e) => setNewDetail(e.target.value)}
              placeholder="Acceptance criteria / specification…"
              className="h-8 min-w-[180px] flex-1 bg-term text-xs"
            />
            <Button type="submit" size="sm" disabled={loading} className="h-8 whitespace-nowrap shrink-0">
              Create Node
            </Button>
          </div>
        </form>
      ) : null}

      {/* Inline Configure Specialist Role Form */}
      {mode === "fleet" && showAddAgent ? (
        <form
          onSubmit={handleSaveAgent}
          className="flex-none space-y-2 border-b border-border bg-secondary/40 px-3 py-2.5 text-xs"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="Agent Name (e.g. Protocol-Scout-02)"
              className="h-8 bg-term text-xs"
              required
            />
            <Input
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
              placeholder="Role (e.g. verification)"
              className="h-8 bg-term text-xs"
              required
            />
            <Input
              value={agentCaps}
              onChange={(e) => setAgentCaps(e.target.value)}
              placeholder="Capabilities (comma-separated)"
              className="h-8 bg-term font-mono text-[11px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              placeholder="System prompt & execution policy…"
              className="h-8 flex-1 bg-term text-xs"
              required
            />
            <Button type="submit" size="sm" disabled={loading} className="h-8 whitespace-nowrap shrink-0">
              Save Role Config
            </Button>
          </div>
        </form>
      ) : null}

      {/* Inline Synthesize Tool Form */}
      {mode === "tools" && showAddTool ? (
        <form
          onSubmit={handleSaveTool}
          className="flex-none space-y-2 border-b border-border bg-secondary/40 px-3 py-2.5 text-xs"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Input
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="tool_name (snake_case)"
              className="h-8 bg-term font-mono text-xs"
              required
            />
            <Input
              value={toolCat}
              onChange={(e) => setToolCat(e.target.value)}
              placeholder="Category (research)"
              className="h-8 bg-term text-xs"
            />
            <select
              aria-label="Tool kind"
              value={toolKind}
              onChange={(e) => setToolKind(e.target.value as "http_json" | "nvidia_analyzer")}
              className="h-8 rounded-md border border-border bg-term px-2 font-mono text-xs text-foreground"
            >
              <option value="http_json">http_json (Live HTTPS API)</option>
              <option value="nvidia_analyzer">nvidia_analyzer (NVIDIA NIM Transform)</option>
            </select>
            <Input
              value={toolDesc}
              onChange={(e) => setToolDesc(e.target.value)}
              placeholder="Tool description…"
              className="h-8 bg-term text-xs"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            {toolKind === "http_json" ? (
              <Input
                value={toolUrlTpl}
                onChange={(e) => setToolUrlTpl(e.target.value)}
                placeholder="https://api.example.com/search?q={{query}}"
                className="h-8 flex-1 bg-term font-mono text-xs"
                required
              />
            ) : (
              <Input
                value={toolPromptTpl}
                onChange={(e) => setToolPromptTpl(e.target.value)}
                placeholder="Structured analysis prompt template…"
                className="h-8 flex-1 bg-term text-xs"
                required
              />
            )}
            <Button type="submit" size="sm" disabled={loading} className="h-8 whitespace-nowrap shrink-0">
              Register Tool
            </Button>
          </div>
        </form>
      ) : null}

      {/* Tab Body */}
      {mode === "graph" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term lg:flex-row">
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              showTimeline ? "overflow-y-auto" : "overflow-hidden",
            )}
          >
            {showTimeline ? (
              <D3TaskTimeline
                taskEvents={taskEvents}
                tasks={tasks}
                now={now}
                missionId={missionOnly ? vitals.activeMissionId : undefined}
              />
            ) : null}

            <div
              className={cn(
                "flex-1 bg-term",
                showTimeline ? "min-h-[260px]" : "min-h-0 overflow-hidden",
                graphSplitMode === "split"
                  ? "flex flex-col md:grid md:grid-cols-12"
                  : "flex flex-col",
              )}
            >
              {graphSplitMode !== "graph" ? (
                <div
                  className={cn(
                    "min-h-0 overflow-hidden",
                    graphSplitMode === "split"
                      ? "h-40 flex-none border-b border-border md:col-span-4 md:h-full md:border-b-0 md:border-r"
                      : "flex-1",
                  )}
                >
                  <TaskChecklist
                    missions={missions}
                    goals={goals}
                    tasks={tasks}
                    activeMissionId={vitals.activeMissionId}
                    missionOnly={missionOnly}
                    goalFilter={goalFilter}
                    selectedNode={selectedNode}
                    onSelectNode={setSelectedNode}
                    onToggleTaskComplete={handleToggleTaskComplete}
                    onReorderTasks={handleReorderTasks}
                    updatingTaskId={updatingTaskId}
                    loading={loading}
                  />
                </div>
              ) : null}

              {graphSplitMode !== "list" ? (
                <div
                  className={cn(
                    "overflow-hidden",
                    showTimeline ? "min-h-[240px]" : "min-h-[220px] md:min-h-0",
                    graphSplitMode === "split" ? "flex-1 md:col-span-8 md:h-full" : "flex-1",
                  )}
                >
                  <D3TaskGraph
                    missions={missions}
                    goals={goals}
                    tasks={tasks}
                    children={children}
                    activeMissionId={vitals.activeMissionId}
                    missionOnly={missionOnly}
                    goalFilter={goalFilter}
                    selectedNode={selectedNode}
                    onSelectNode={setSelectedNode}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {selectedTask || selectedMission || selectedGoal || selectedWorker ? (
            <aside
              data-testid="task-metadata-panel"
              aria-label="Selected node metadata panel"
              className="flex max-h-[250px] w-full flex-none flex-col gap-3 overflow-y-auto border-t border-border bg-card/90 p-3 text-xs lg:max-h-none lg:w-[280px] lg:border-t-0 lg:border-l"
            >
              {selectedTask && selectedTaskMeta ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-border/60 pb-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <span className="font-semibold text-foreground">{selectedTask.id}</span>
                        <span>·</span>
                        <span
                          className={cn(
                            "rounded border px-1 py-0.5 text-[9.5px] uppercase",
                            taskPriorityBadgeClass(normalizeTaskPriority(selectedTask.priority)),
                          )}
                        >
                          {taskPriorityLabel(normalizeTaskPriority(selectedTask.priority))}
                        </span>
                      </div>
                      <h3 className="mt-1 font-medium leading-snug text-foreground">
                        {selectedTask.title}
                      </h3>
                      {selectedTask.detail ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          {selectedTask.detail}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedNode(null)}
                      aria-label="Close task metadata panel"
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground shrink-0"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>

                  {/* Timing */}
                  <div className="space-y-1 rounded border border-border/70 bg-term/80 p-2 font-mono text-[10px]">
                    <p className="flex items-center gap-1 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      <Clock className="size-3" />
                      <span>Execution Timing</span>
                    </p>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums">
                      <span className="text-muted-foreground">Start Time</span>
                      <span className="text-right text-foreground">
                        {formatShortTimestamp(selectedTaskMeta.startTime)}
                      </span>
                      <span className="text-muted-foreground">Last Updated</span>
                      <span className="text-right text-foreground">
                        {selectedTaskMeta.updatedTime
                          ? formatAgo(selectedTaskMeta.updatedTime, now)
                          : "—"}
                      </span>
                      <span className="text-muted-foreground">Elapsed</span>
                      <span className="text-right text-warn">
                        {formatDurationCompact(selectedTaskMeta.elapsedMs)}
                      </span>
                    </div>
                  </div>

                  {/* Resource Usage */}
                  <div className="space-y-1 rounded border border-border/70 bg-term/80 p-2 font-mono text-[10px]">
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      Resource Usage
                    </p>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums">
                      <span className="text-muted-foreground">Assignee</span>
                      <span className="truncate text-right text-foreground">
                        {selectedTask.assignee} ({selectedTask.role})
                      </span>
                      <span className="text-muted-foreground">Cycles / Time</span>
                      <span className="text-right text-foreground">
                        {selectedTaskMeta.resourceUsage.cyclesCount} ·{" "}
                        {formatDurationCompact(selectedTaskMeta.resourceUsage.totalDurationMs)}
                      </span>
                      <span className="text-muted-foreground">Compute Spend</span>
                      <span className="text-right text-ok">
                        {formatCents(selectedTaskMeta.resourceUsage.spendCents)}
                      </span>
                      <span className="text-muted-foreground">Tools / Handoffs</span>
                      <span className="text-right text-foreground">
                        {selectedTaskMeta.resourceUsage.toolInvocations} ·{" "}
                        {selectedTaskMeta.resourceUsage.handoffMessages}
                      </span>
                    </div>
                    {selectedTaskMeta.resourceUsage.modelName ? (
                      <p className="truncate border-t border-border/50 pt-1 text-[9.5px] text-muted-foreground">
                        model: {selectedTaskMeta.resourceUsage.modelName}
                      </p>
                    ) : null}
                  </div>

                  {/* Status & Priority Controls */}
                  <div className="space-y-2">
                    <div>
                      <p className="mb-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        Status
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {STATUS_OPTIONS.map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={loading || selectedTask.status === st}
                            onClick={() => void handleStatusChange(selectedTask.id, st)}
                            className={cn(
                              "h-6 rounded border px-1.5 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                              selectedTask.status === st
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-term text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {taskStatusLabel(st)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        Priority
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {PRIORITY_OPTIONS.map((prio) => {
                          const active = normalizeTaskPriority(selectedTask.priority) === prio;
                          return (
                            <button
                              key={prio}
                              type="button"
                              data-testid={`inspector-priority-${prio}`}
                              disabled={loading || active}
                              onClick={() => void handlePriorityChange(selectedTask.id, prio)}
                              className={cn(
                                "h-6 rounded border px-2 font-mono text-[10px] uppercase whitespace-nowrap shrink-0 transition-colors",
                                active
                                  ? taskPriorityBadgeClass(prio)
                                  : "border-border bg-term text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {taskPriorityLabel(prio)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Transitive Lineage Links */}
                  <div className="space-y-1.5 border-t border-border/60 pt-2 font-mono text-[10px]">
                    <div>
                      <p className="text-[9.5px] uppercase tracking-wider text-[#c4a574]">
                        Upstream Parents ({selectedTaskMeta.upstreamTasks.length})
                      </p>
                      {selectedTaskMeta.upstreamTasks.length === 0 ? (
                        <p className="text-muted-foreground">Root task (no upstream task blockers)</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {selectedTaskMeta.upstreamTasks.map((up) => (
                            <button
                              key={up.id}
                              type="button"
                              onClick={() => setSelectedNode({ kind: "task", id: up.id })}
                              className="max-w-full truncate rounded border border-[#c4a574]/40 bg-[#c4a574]/10 px-1.5 py-0.5 text-left text-[10px] text-foreground hover:bg-[#c4a574]/20"
                            >
                              {up.id} · {up.status}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <p className="text-[9.5px] uppercase tracking-wider text-[#6ea8c7]">
                        Downstream Tasks ({selectedTaskMeta.downstreamTasks.length})
                      </p>
                      {selectedTaskMeta.downstreamTasks.length === 0 ? (
                        <p className="text-muted-foreground">Terminal leaf task</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {selectedTaskMeta.downstreamTasks.map((down) => (
                            <button
                              key={down.id}
                              type="button"
                              onClick={() => setSelectedNode({ kind: "task", id: down.id })}
                              className="max-w-full truncate rounded border border-[#6ea8c7]/40 bg-[#6ea8c7]/10 px-1.5 py-0.5 text-left text-[10px] text-foreground hover:bg-[#6ea8c7]/20"
                            >
                              {down.id} · {down.status}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {selectedTask.result ? (
                    <div className="rounded border border-ok/35 bg-ok/10 p-2 font-mono text-[10px] text-ok">
                      result: {selectedTask.result}
                    </div>
                  ) : null}

                  {selectedTaskMeta.recentEvents.length > 0 ? (
                    <div className="space-y-1 border-t border-border/60 pt-2 font-mono text-[10px]">
                      <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        Recent Transitions
                      </p>
                      <ul className="space-y-1">
                        {selectedTaskMeta.recentEvents.slice(0, 4).map((ev) => (
                          <li key={ev.id} className="flex items-center justify-between gap-2 text-muted-foreground">
                            <span className="truncate text-foreground">
                              {ev.previousStatus ? `${ev.previousStatus}→${ev.status}` : ev.status} ({ev.actor})
                            </span>
                            <span className="shrink-0 tabular-nums">{formatAgo(ev.createdAt, now)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : selectedMission ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-border/60 pb-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {selectedMission.id} · {selectedMission.status.toUpperCase()}
                      </p>
                      <h3 className="mt-0.5 font-medium text-foreground">{selectedMission.title}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedNode(null)}
                      aria-label="Close mission metadata panel"
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground shrink-0"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{selectedMission.objective}</p>
                  <div className="grid grid-cols-2 gap-1 rounded border border-border/70 bg-term/80 p-2 font-mono text-[10px] tabular-nums">
                    <span className="text-muted-foreground">Start</span>
                    <span className="text-right text-foreground">{formatShortTimestamp(selectedMission.createdAt)}</span>
                    <span className="text-muted-foreground">Cycles</span>
                    <span className="text-right text-foreground">
                      {selectedMission.cycleCount}/{selectedMission.maxCycles}
                    </span>
                    <span className="text-muted-foreground">Orchestrator</span>
                    <span className="truncate text-right text-foreground">{selectedMission.orchestrator}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedMission.status !== "completed" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => void controlMission(selectedMission.id, "complete")}
                        className="h-7 text-xs whitespace-nowrap shrink-0"
                      >
                        Complete Mission
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => void controlMission(selectedMission.id, "resume", 4)}
                        className="h-7 text-xs whitespace-nowrap shrink-0"
                      >
                        Resume (+4)
                      </Button>
                    )}
                  </div>
                </>
              ) : selectedGoal ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-border/60 pb-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {selectedGoal.id} · {selectedGoal.status.toUpperCase()}
                      </p>
                      <h3 className="mt-0.5 font-medium text-foreground">{selectedGoal.title}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedNode(null)}
                      aria-label="Close goal metadata panel"
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground shrink-0"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{selectedGoal.detail}</p>
                  <div className="grid grid-cols-2 gap-1 rounded border border-border/70 bg-term/80 p-2 font-mono text-[10px] tabular-nums">
                    <span className="text-muted-foreground">Progress</span>
                    <span className="text-right text-ok">{selectedGoal.progress}%</span>
                    <span className="text-muted-foreground">Expected Rev</span>
                    <span className="text-right text-foreground">{formatCents(selectedGoal.expectedRevenueCents)}</span>
                    <span className="text-muted-foreground">Actual Rev</span>
                    <span className="text-right text-foreground">{formatCents(selectedGoal.actualRevenueCents)}</span>
                  </div>
                </>
              ) : selectedWorker ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-border/60 pb-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {selectedWorker.id} · {selectedWorker.role}
                      </p>
                      <h3 className="mt-0.5 font-medium text-foreground">{selectedWorker.name}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedNode(null)}
                      aria-label="Close worker metadata panel"
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground shrink-0"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1 rounded border border-border/70 bg-term/80 p-2 font-mono text-[10px] tabular-nums">
                    <span className="text-muted-foreground">Status</span>
                    <span className="text-right text-foreground">{childStatusLabel(selectedWorker.status)}</span>
                    <span className="text-muted-foreground">Cycles</span>
                    <span className="text-right text-foreground">{selectedWorker.cycleCount}</span>
                    <span className="text-muted-foreground">Latency</span>
                    <span className="text-right text-foreground">
                      {selectedWorker.latencyMs ? `${selectedWorker.latencyMs}ms` : "—"}
                    </span>
                    <span className="text-muted-foreground">Model</span>
                    <span className="truncate text-right text-foreground">{selectedWorker.model}</span>
                  </div>
                  {selectedWorker.systemPrompt ? (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{selectedWorker.systemPrompt}</p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => void pingWorker(selectedWorker.id)}
                    className="h-7 text-xs whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="size-3" />
                    <span>Verify Heartbeat</span>
                  </Button>
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : mode === "fleet" ? (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto bg-term/60">
          {children.map((w) => {
            const tone = childTone(w.status);
            return (
              <div
                key={w.id}
                onClick={() => setSelectedNode({ kind: "worker", id: w.id })}
                className={cn(
                  "flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-secondary/40",
                  selectedNode?.kind === "worker" && selectedNode.id === w.id && "bg-secondary/50",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot tone={tone} />
                    <span className="text-sm font-medium text-foreground">{w.name}</span>
                    <span className={cn("font-mono text-[11px] uppercase", toneTextClass(tone))}>
                      {childStatusLabel(w.status)}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      · {w.role} · {w.model} · {w.cycleCount} cycles
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {w.task ?? "Standby — ready for assignment"}
                  </p>
                  {w.capabilities.length > 0 ? (
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80">
                      tools: {w.capabilities.join(" · ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  <span>{w.latencyMs ? `${w.latencyMs}ms` : "—"}</span>
                  <span>{formatAgo(now - w.lastBeatAgoMs, now)}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={turnRunning}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runTurn({ targetAgentName: w.name });
                    }}
                    className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
                  >
                    <Play className="size-3" />
                    <span>Turn</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      void pingWorker(w.id);
                    }}
                    className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="size-3" />
                    <span>Probe</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : mode === "cycles" ? (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto bg-term/60 p-3 space-y-2.5">
          {cycles.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs text-muted-foreground">
              No Perceive-Reason-Act-Observe cycles executed yet.
            </p>
          ) : (
            cycles.map((c) => (
              <div key={c.id} className="rounded border border-border bg-card p-3 text-xs space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="inline-flex flex-wrap items-center gap-1.5 font-semibold text-foreground">
                    <span>
                      Turn #{c.turnNumber} · {c.agentName} ({c.agentRole})
                    </span>
                    {c.mode && c.mode !== "mission" ? (
                      <span
                        className={cn(
                          "rounded border px-1 py-0.5 text-[9px] uppercase",
                          c.mode === "self_evolution"
                            ? "border-ok/40 bg-ok/15 text-ok"
                            : "border-warn/40 bg-warn/10 text-warn",
                        )}
                      >
                        {c.mode === "self_evolution" ? "SELF-EVO" : c.mode.toUpperCase()}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {c.tier} · {c.durationMs}ms · {formatCents(c.costCents)} ·{" "}
                    {formatAgo(c.createdAt, now)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1.5 font-mono text-[11px] md:grid-cols-2">
                  <div className="rounded border border-border/60 bg-term px-2.5 py-1.5">
                    <span className="text-muted-foreground uppercase text-[10px]">1. Perceive</span>
                    <p className="mt-0.5 text-foreground/90">{c.phasePerceive}</p>
                  </div>
                  <div className="rounded border border-border/60 bg-term px-2.5 py-1.5">
                    <span className="text-muted-foreground uppercase text-[10px]">2. Reason / Plan</span>
                    <p className="mt-0.5 text-foreground/90">{c.phaseReason}</p>
                  </div>
                  <div className="rounded border border-border/60 bg-term px-2.5 py-1.5">
                    <span className="text-warn uppercase text-[10px]">3. Act</span>
                    <p className="mt-0.5 text-foreground/90">{c.phaseAct}</p>
                  </div>
                  <div className="rounded border border-border/60 bg-term px-2.5 py-1.5">
                    <span className="text-ok uppercase text-[10px]">4. Observe</span>
                    <p className="mt-0.5 text-foreground/90">{c.phaseObserve}</p>
                  </div>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  tools: {c.toolsUsed.length > 0 ? c.toolsUsed.join(" · ") : "none"}
                  {c.handoffTo ? ` · handoff → ${c.handoffTo}` : ""}
                </p>
              </div>
            ))
          )}
        </div>
      ) : mode === "evolution" ? (
        <EvolutionPanel />
      ) : mode === "domains" ? (
        <DomainStudioPanel />
      ) : mode === "census" ? (
        <FleetCensus />
      ) : mode === "grounding" ? (
        <GroundingPanel />
      ) : mode === "video" ? (
        <VideoStudioPanel />
      ) : (
        /* Tool Forge & Live Capability Runner */
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term/60">
          <form
            onSubmit={handleRunToolTest}
            className="flex-none space-y-2 border-b border-border bg-secondary/25 p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Select tool to invoke"
                value={activeToolName}
                onChange={(e) => {
                  const next = e.target.value;
                  setActiveToolName(next);
                  if (next === "search_arxiv") {
                    setToolArgsJson('{"query":"multi-agent dynamic role assignment","maxResults":3}');
                  } else if (next === "search_github_repos") {
                    setToolArgsJson('{"query":"multi-agent orchestration typescript","maxResults":3}');
                  } else if (next === "hackernews_top_stories") {
                    setToolArgsJson("{}");
                  } else if (next === "query_pubmed_trials") {
                    setToolArgsJson('{"query":"semaglutide cardiovascular","maxResults":4}');
                  } else if (next === "query_openfda_events") {
                    setToolArgsJson('{"query":"semaglutide","maxResults":4}');
                  } else if (next === "query_usgs_weather") {
                    setToolArgsJson('{"latitude":37.7749,"longitude":-122.4194,"minMagnitude":3.5}');
                  } else if (next === "query_nvd_cves") {
                    setToolArgsJson('{"query":"openssl","maxResults":4}');
                  } else if (next === "query_federal_register") {
                    setToolArgsJson('{"query":"semiconductor supply chain","maxResults":4}');
                  } else if (next === "analyze_url_context") {
                    setToolArgsJson('{"urls":["https://modelcontextprotocol.io/introduction"],"prompt":"Summarize the core architecture."}');
                  } else {
                    setToolArgsJson('{"query":"autonomous multi-agent frameworks"}');
                  }
                }}
                className="h-8 rounded border border-border bg-term px-2 font-mono text-xs text-foreground"
              >
                {tools.map((tl) => (
                  <option key={tl.id} value={tl.name}>
                    {tl.name} ({tl.kind})
                  </option>
                ))}
              </select>
              <Input
                value={toolArgsJson}
                onChange={(e) => setToolArgsJson(e.target.value)}
                placeholder='{"query":"..."}'
                className="h-8 flex-1 bg-term font-mono text-xs"
              />
              <Button type="submit" size="sm" disabled={loading} className="h-8 whitespace-nowrap shrink-0">
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                <span>Execute Live</span>
              </Button>
            </div>
            {lastToolOutput ? (
              <div
                data-testid="tool-forge-output"
                className="rounded border border-border bg-term p-2 font-mono text-[11px]"
              >
                <div className="mb-1 flex items-center justify-between text-muted-foreground">
                  <span className={lastToolOutput.ok ? "text-ok" : "text-destructive"}>
                    {lastToolOutput.toolName} · {lastToolOutput.ok ? "LIVE OK" : "ERROR"} ·{" "}
                    {lastToolOutput.durationMs}ms
                  </span>
                </div>
                <pre className="max-h-36 overflow-auto text-[10px] text-foreground/90 whitespace-pre-wrap">
                  {JSON.stringify(lastToolOutput.output, null, 2)}
                </pre>
              </div>
            ) : loading ? (
              <div className="rounded border border-border bg-term p-2 font-mono text-[11px] text-muted-foreground">
                Executing {activeToolName} against live endpoint…
              </div>
            ) : null}
          </form>

          <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto">
            {tools.map((tl) => (
              <div key={tl.id} className="px-3 py-2.5 text-xs hover:bg-secondary/20">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-mono">
                    <span className="font-medium text-foreground">{tl.name}</span>
                    <span className="text-[11px] text-warn">· {tl.kind}</span>
                    <span className="text-[11px] text-muted-foreground">· {tl.category}</span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    by {tl.createdBy} · {tl.usageCount} uses
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">{tl.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compact Inspector Footer when outside Task DAG or when no node is selected */}
      {mode !== "graph" && selectedTask ? (
        <div
          data-testid="task-inspector-footer"
          className="flex-none border-t border-border bg-secondary/40 px-3 py-2.5 text-xs"
        >
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="w-full min-w-0 md:w-auto md:flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                <span className="text-foreground font-semibold">{selectedTask.id}</span>
                <span>·</span>
                <span>goal: {selectedTask.goalId}</span>
                <span>·</span>
                <span>assignee: {selectedTask.assignee}</span>
                <span>·</span>
                <span>role: {selectedTask.role}</span>
              </div>
              <p className="mt-0.5 font-medium text-foreground">{selectedTask.title}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1 shrink-0">
              {PRIORITY_OPTIONS.map((prio) => {
                const active = normalizeTaskPriority(selectedTask.priority) === prio;
                return (
                  <button
                    key={prio}
                    type="button"
                    data-testid={`inspector-priority-${prio}`}
                    disabled={loading || active}
                    onClick={() => void handlePriorityChange(selectedTask.id, prio)}
                    className={cn(
                      "h-6 rounded border px-2 font-mono text-[10px] uppercase whitespace-nowrap shrink-0 transition-colors",
                      active
                        ? taskPriorityBadgeClass(prio)
                        : "border-border bg-term text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {taskPriorityLabel(prio)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : mode !== "graph" && selectedMission ? (
        <div className="flex-none border-t border-border bg-secondary/40 px-3 py-2.5 text-xs">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="w-full min-w-0 md:w-auto md:flex-1">
              <p className="font-mono text-[11px] text-muted-foreground">
                {selectedMission.id} · {selectedMission.status.toUpperCase()} ·{" "}
                {selectedMission.cycleCount}/{selectedMission.maxCycles} cycles
              </p>
              <p className="font-medium text-foreground">{selectedMission.title}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedNode(null)} className="h-7 text-xs">
              Close
            </Button>
          </div>
        </div>
      ) : mode !== "graph" && selectedGoal ? (
        <div className="flex-none border-t border-border bg-secondary/40 px-3 py-2.5 text-xs">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="w-full min-w-0 md:w-auto md:flex-1">
              <p className="font-mono text-[11px] text-muted-foreground">
                {selectedGoal.id} · {selectedGoal.status} · {selectedGoal.progress}%
              </p>
              <p className="font-medium text-foreground">{selectedGoal.title}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedNode(null)} className="h-7 text-xs">
              Close
            </Button>
          </div>
        </div>
      ) : mode !== "graph" && selectedWorker ? (
        <div className="flex-none border-t border-border bg-secondary/40 px-3 py-2.5 text-xs">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="w-full min-w-0 md:w-auto md:flex-1">
              <p className="font-mono text-[11px] text-muted-foreground">
                {selectedWorker.id} · {selectedWorker.role} · {childStatusLabel(selectedWorker.status)} ·{" "}
                {selectedWorker.cycleCount} cycles
              </p>
              <p className="font-medium text-foreground">
                {selectedWorker.name} — {selectedWorker.task ?? "Standby"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void pingWorker(selectedWorker.id)}
                className="h-7 text-xs whitespace-nowrap shrink-0"
              >
                <RefreshCw className="size-3" />
                <span>Verify Node</span>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedNode(null)} className="h-7 text-xs">
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : !selectedNode ? (
        <div className="flex-none border-t border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          Click any Mission, Goal, Task, or Agent node to highlight transitive lineage and open its metadata panel.
        </div>
      ) : null}
    </section>
  );
}
