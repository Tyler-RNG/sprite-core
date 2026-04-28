import { useSyncExternalStore } from "react";
import type { Observable } from "@tylerwarburton/sprite-core-client";

/**
 * Bridge the SDK's Observable primitive into React via useSyncExternalStore.
 *
 * The SDK's subscribe() invokes the listener synchronously with the current
 * value on subscribe — that's fine here because React only uses the callback
 * as a "store changed" signal and re-reads via getSnapshot regardless.
 *
 * Snapshot stability: the SDK dedupes with Object.is in MutableObservable.set,
 * so callers that feed it the same reference get a stable snapshot. Callers
 * that rebuild objects on every tick will still work — React will treat them
 * as changed, which is correct.
 */
export function useObservable<T>(obs: Observable<T>): T {
  return useSyncExternalStore(
    (onChange) => obs.subscribe(() => onChange()),
    () => obs.value,
    () => obs.value,
  );
}
