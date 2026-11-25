/**
 * Cletus Memory Sanitizer & Fluff Blocker
 * Ensures zero meta-commentary, capability expansion turn logs, build status notices, or robotic fluff is ever recorded to database memory or logs.
 */

export function shouldDiscardLogOrMemory(text: string): boolean {
  const clean = String(text || "").toLowerCase();
  if (!clean.trim()) return true;

  const forbiddenPatterns = [
    "capability expansion",
    "codebase build status",
    "active skills:",
    "system capability continuously expanding",
    "pristine",
    "turn #",
  ];

  for (const pattern of forbiddenPatterns) {
    if (clean.includes(pattern)) {
      return true;
    }
  }

  return false;
}
