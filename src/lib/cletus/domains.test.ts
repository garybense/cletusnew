import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDomainActivationPlan,
  cosineSimilarity,
  getDomainPack,
  listDomainPacks,
  rankDomainMemories,
} from "./domains";
import { wouldCreateTaskCycle } from "./mas-engine";
import type { DomainMemoryItem, Task } from "./types";

describe("Multi-Domain Operational Catalog & Activation", () => {
  it("exposes all 5 distinct operational domain packs with specialists, tools, and connectors", () => {
    const packs = listDomainPacks();
    assert.equal(packs.length, 5);
    const ids = packs.map((p) => p.id);
    assert.deepEqual(ids, [
      "mas_rnd",
      "biomed_clinical",
      "climate_geospatial",
      "finance_secops",
      "policy_supply",
    ]);

    for (const pack of packs) {
      assert.ok(pack.specialists.some((s) => s.role === "orchestrator"));
      assert.ok(pack.specialists.some((s) => s.name === "Verification-Auditor-01"));
      assert.ok(pack.tools.length >= 1, `${pack.id} must define tools`);
      assert.ok(pack.connectors.length >= 2, `${pack.id} must define live connectors`);
      assert.ok(pack.urlPresets.length >= 2, `${pack.id} must define URL presets`);
      assert.ok(pack.goals.length >= 2, `${pack.id} must define goals`);
      assert.ok(pack.tasks.length >= 3, `${pack.id} must define tasks`);
    }
  });

  it("falls back safely to mas_rnd when given an unknown domain ID", () => {
    const fallback = getDomainPack("unknown_domain");
    assert.equal(fallback.id, "mas_rnd");
    assert.equal(getDomainPack("biomed_clinical").id, "biomed_clinical");
  });

  it("builds acyclic activation plans with custom focus injected across mission & first task", () => {
    for (const pack of listDomainPacks()) {
      const plan = buildDomainActivationPlan(pack.id, "Q4 critical readiness", 1_760_000_000_000);
      assert.ok(plan.missionId.startsWith(`msn_${pack.id}`));
      assert.ok(plan.missionTitle.includes("Q4 critical readiness"));
      assert.ok(plan.missionObjective.includes("Q4 critical readiness"));
      assert.ok(plan.tasks[0]!.title.includes("Q4 critical readiness"));

      const acc: Task[] = [];
      for (const t of plan.tasks) {
        assert.equal(wouldCreateTaskCycle(acc, t.id, t.dependsOn), false);
        acc.push({
          id: t.id,
          goalId: t.goalId,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          role: t.role,
          dependsOn: t.dependsOn,
          createdAt: t.createdAt,
        });
      }
    }
  });
});

describe("Semantic & Lexical Domain Memory Ranking", () => {
  it("computes exact cosine similarity for aligned and orthogonal vectors", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-6);
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-6);
    assert.equal(cosineSimilarity([], [1, 2]), 0);
  });

  it("ranks memories semantically when embeddings exist and falls back to lexical otherwise", () => {
    const baseItem = (id: string, title: string, summary: string, hasEmbedding: boolean): DomainMemoryItem => ({
      id,
      domainId: "biomed_clinical",
      sourceType: "connector",
      title,
      summary,
      hasEmbedding,
      embeddingDimensions: hasEmbedding ? 3 : undefined,
      tags: ["clinical"],
      createdAt: 1000,
    });

    const semanticResults = rankDomainMemories(
      [
        { item: baseItem("m1", "Cardiology Trial", "GLP-1 trial outcomes", true), embedding: [0.95, 0.1, 0.05] },
        { item: baseItem("m2", "Unrelated Supply", "Port cargo notice", true), embedding: [0.05, 0.95, 0.0] },
      ],
      "cardiology",
      [1, 0, 0],
    );
    assert.equal(semanticResults[0]!.item.id, "m1");
    assert.equal(semanticResults[0]!.matchKind, "semantic");

    const lexicalResults = rankDomainMemories(
      [
        { item: baseItem("m1", "USGS Quake Alert", "Magnitude 4.8 seismic event near Tokyo", false) },
        { item: baseItem("m2", "NVD CVE Feed", "OpenSSL buffer overflow advisory", false) },
      ],
      "seismic tokyo",
      null,
    );
    assert.equal(lexicalResults.length, 1);
    assert.equal(lexicalResults[0]!.item.id, "m1");
    assert.equal(lexicalResults[0]!.matchKind, "lexical");
  });
});
