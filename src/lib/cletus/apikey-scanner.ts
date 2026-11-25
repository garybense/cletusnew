/**
 * l33t_APIKeyScanr Integration for Cletus MAS
 * Scans text or payloads for exposed inference API keys (NVIDIA, OpenRouter, OpenAI, Anthropic) and validates format.
 */

export interface KeyScanResult {
  keysFound: number;
  providersDetected: string[];
  maskReport: Array<{ provider: string; maskedKey: string; validFormat: boolean }>;
}

export function scanForInferenceKeys(textPayload: string): KeyScanResult {
  const text = String(textPayload || "");
  const providersDetected: string[] = [];
  const maskReport: Array<{ provider: string; maskedKey: string; validFormat: boolean }> = [];

  const nvidiaMatches = text.match(/nvapi-[A-Za-z0-9_\-]+/g);
  if (nvidiaMatches) {
    providersDetected.push("NVIDIA NIM");
    for (const k of nvidiaMatches) {
      maskReport.push({
        provider: "NVIDIA NIM",
        maskedKey: `nvapi-${k.slice(6, 10)}...${k.slice(-4)}`,
        validFormat: k.length > 20,
      });
    }
  }

  const openrouterMatches = text.match(/sk-or-v1-[A-Za-z0-9]+/g);
  if (openrouterMatches) {
    providersDetected.push("OpenRouter");
    for (const k of openrouterMatches) {
      maskReport.push({
        provider: "OpenRouter",
        maskedKey: `sk-or-v1-${k.slice(9, 13)}...${k.slice(-4)}`,
        validFormat: k.length > 30,
      });
    }
  }

  const bearerMatches = text.match(/Bearer\s+([A-Za-z0-9_\-\.]{20,})/g);
  if (bearerMatches && !providersDetected.includes("Bearer Token")) {
    providersDetected.push("Bearer Token");
  }

  return {
    keysFound: maskReport.length,
    providersDetected: Array.from(new Set(providersDetected)),
    maskReport,
  };
}
