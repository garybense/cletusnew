/**
 * Psycholinguistix Integration for Cletus MAS
 * Analyzes cognitive linguistic framing, tone, and rhetorical structure in text and speech transcripts.
 */

export function analyzePsycholinguisticFraming(text: string): {
  sentiment: "positive" | "neutral" | "assertive" | "analytical";
  complexityScore: number;
  framingTone: string;
  keyKeywords: string[];
} {
  const clean = String(text || "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const avgWordLen = wordCount > 0 ? words.reduce((acc, w) => acc + w.length, 0) / wordCount : 0;

  let sentiment: "positive" | "neutral" | "assertive" | "analytical" = "analytical";
  if (clean.includes("!") || clean.toLowerCase().includes("urgent") || clean.toLowerCase().includes("execute")) {
    sentiment = "assertive";
  } else if (avgWordLen > 5.5) {
    sentiment = "analytical";
  } else {
    sentiment = "neutral";
  }

  const uniqueWords = Array.from(new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, "")))).filter(w => w.length > 4);

  return {
    sentiment,
    complexityScore: Number((avgWordLen * 1.4 + Math.min(10, wordCount * 0.1)).toFixed(2)),
    framingTone: `Cognitive density index ${avgWordLen > 5 ? "high" : "balanced"} with ${sentiment} modality.`,
    keyKeywords: uniqueWords.slice(0, 5),
  };
}
