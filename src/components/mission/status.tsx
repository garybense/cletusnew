import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/cletus/format";

export function StatusDot({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-ok",
        tone === "warn" && "bg-warn",
        tone === "crit" && "bg-destructive",
        tone === "mute" && "bg-muted-foreground",
        className,
      )}
    />
  );
}
