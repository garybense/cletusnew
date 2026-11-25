import type { Sql } from "@/lib/db";
import { nid } from "./format";
import { getTierPolicy, tierFromCredits } from "./mas-engine";

export interface PolicyEvaluation {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

const TREASURY_LIMITS = {
  maxSingleTransferCents: 5000,
  maxChildFundingCents: 2500,
  requireConfirmationAboveCents: 1000,
  minimumReserveCents: 1000,
};

const PROTECTED_PATTERNS = [
  /wallet\.json/i,
  /cletus\.json/i,
  /\.env/i,
  /rm\s+-rf/i,
  /\beval\s*\(/i,
  /new\s+Function/i,
  /child_process/i,
];

export async function evaluateToolPolicy(
  sql: Sql,
  params: {
    tool: string;
    creditsCents: number;
    reserveCents: number;
    spendCents?: number;
    textArg?: string;
  },
): Promise<PolicyEvaluation> {
  const { tool, creditsCents, reserveCents, spendCents = 0, textArg = "" } = params;
  const now = Date.now();
  const tier = tierFromCredits(creditsCents, reserveCents);
  const tierPolicy = getTierPolicy(tier, reserveCents);

  if (!tierPolicy.canRunInference && tool !== "check_treasury" && tool !== "reply_to_operator") {
    const rule = "survival_tier=dead — inference & execution halted until credits replenished";
    await recordDenial(sql, now, tool, rule);
    return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
  }

  for (const pat of PROTECTED_PATTERNS) {
    if (pat.test(textArg)) {
      const rule = "command/resource safety — protected runtime pattern";
      await recordDenial(sql, now, tool, rule);
      return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
    }
  }

  if (tool === "synthesize_tool" && !tierPolicy.allowToolSynthesis) {
    const rule = `survival_tier=${tier} — tool synthesis suspended to conserve reserve`;
    await recordDenial(sql, now, tool, rule);
    return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
  }

  if (tool === "configure_agent_role" && !tierPolicy.allowSpawnWorkers && spendCents > 0) {
    const rule = `survival_tier=${tier} — funded agent expansion suspended`;
    await recordDenial(sql, now, tool, rule);
    return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
  }

  if (spendCents > 0) {
    if (creditsCents - spendCents < Math.max(reserveCents, TREASURY_LIMITS.minimumReserveCents)) {
      const rule = `minimum_reserve ${(reserveCents / 100).toFixed(2)} cr — spend ${(spendCents / 100).toFixed(2)} would breach floor`;
      await recordDenial(sql, now, tool, rule);
      return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
    }

    const effectiveChildLimit = Math.min(
      TREASURY_LIMITS.maxChildFundingCents,
      tierPolicy.maxChildFundingCents,
    );

    if ((tool === "dispatch_worker" || tool === "configure_agent_role") && spendCents > effectiveChildLimit) {
      const rule = `max_worker_funding(${tier}) ${(effectiveChildLimit / 100).toFixed(2)} — requested ${(spendCents / 100).toFixed(2)}`;
      await recordDenial(sql, now, tool, rule);
      return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
    }

    if (spendCents > TREASURY_LIMITS.maxSingleTransferCents) {
      const rule = `max_single_transfer ${(TREASURY_LIMITS.maxSingleTransferCents / 100).toFixed(2)} — requested ${(spendCents / 100).toFixed(2)}`;
      await recordDenial(sql, now, tool, rule);
      return { allowed: false, rule, reason: `Blocked by PolicyEngine: ${rule}` };
    }
  }

  return { allowed: true };
}

async function recordDenial(sql: Sql, at: number, tool: string, rule: string): Promise<void> {
  await sql`
    INSERT INTO cletus_denials (id, at, tool, rule)
    VALUES (${nid("den")}, ${at}, ${tool}, ${rule})
  `;
  await sql`
    INSERT INTO cletus_logs (id, at, level, source, message)
    VALUES (${nid("log")}, ${at}, 'warn', 'policy', ${`deny ${tool} · ${rule}`})
  `;
}
