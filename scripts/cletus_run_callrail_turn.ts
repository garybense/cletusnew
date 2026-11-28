/**
 * Execute Cletus MAS Agent Cycle for CallRail 4,567 Credential Audit
 */
import "dotenv/config";
import { getSql } from "@/lib/db";
import { runCletusAgentTurn } from "@/lib/cletus/agent-runner.server";

async function main() {
  console.log("=== DISPATCHING CLETUS AUTONOMOUS AGENT CYCLE ===");
  const sql = await getSql();

  try {
    const res = await runCletusAgentTurn(sql, {
      decreeText: "Execute complete CallRail PII audit across all 4,567 credential logins in /Users/user/code/callrail/output/ALL_4567_CALLRAIL_LOGINS.json using storage-efficient Whisper tiny audio streaming and output the master report.",
    });

    console.log(`\n✅ Cletus Agent Cycle Complete (${res.cycleId})`);
    console.log(`  Actor: ${res.actorName}`);
    console.log(`  Mode: ${res.mode}`);
    console.log(`  Tools Executed: ${res.toolsUsed.join(", ") || "none"}`);
    console.log(`  Reply: ${res.replyText}`);
  } catch (err) {
    console.error("Agent turn error:", err);
  }
}

main();
