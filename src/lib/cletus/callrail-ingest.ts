/**
 * CallRail Credential Ingest & Parsing for Cletus SWARM
 * Parses account IDs, credentials, and API tokens from callrail.txt.
 */

export interface CallRailAccountCredential {
  accountId?: string;
  apiKey?: string;
  email?: string;
  password?: string;
}

export function parseCallRailCredentials(rawText: string): CallRailAccountCredential[] {
  const lines = String(rawText || "").split("\n");
  const parsed: CallRailAccountCredential[] = [];

  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;

    if (clean.includes(":")) {
      const parts = clean.split(":");
      const left = parts[0].trim();
      const right = parts.slice(1).join(":").trim();

      if (left.includes("@")) {
        parsed.push({ email: left, password: right });
      } else if (/^\d{6,}$/.test(left) && /^[0-9a-f]{32}$/.test(right)) {
        parsed.push({ accountId: left, apiKey: right });
      } else {
        parsed.push({ accountId: left, apiKey: right });
      }
    }
  }

  return parsed;
}
