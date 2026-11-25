import { createContext, useContext } from "react";
import { useCletusStore } from "@/lib/cletus/store";
import type { CletusSnapshot } from "@/lib/cletus/types";

export const InitialSnapshotContext = createContext<CletusSnapshot | null>(null);

export function useMissionField<T>(selector: (state: CletusSnapshot) => T): T {
  const initial = useContext(InitialSnapshotContext);
  const hydrated = useCletusStore((s) => s.hydrated);
  const storeVal = useCletusStore(selector);
  if (!hydrated && initial) {
    return selector(initial);
  }
  return storeVal;
}

export function useMissionClock(): number {
  const initial = useContext(InitialSnapshotContext);
  const hydrated = useCletusStore((s) => s.hydrated);
  const now = useCletusStore((s) => s.now);
  if (!hydrated && initial) {
    return initial.serverNow;
  }
  return now;
}
