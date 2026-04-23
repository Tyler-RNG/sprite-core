/**
 * Minimal observable value. Held as a single writable cell with a listener
 * set — matches `MutableStateFlow<T>` on the Kotlin side closely enough that
 * subscribers see the current value + every subsequent update. Not a
 * reactive system; exists only so the player can expose `currentRef` /
 * `currentState` without pulling in rxjs.
 */
export interface Observable<T> {
  readonly value: T;
  subscribe(listener: (value: T) => void): () => void;
}

export class MutableObservable<T> implements Observable<T> {
  private current: T;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.current = initial;
  }

  get value(): T {
    return this.current;
  }

  set(next: T): void {
    if (Object.is(this.current, next)) return;
    this.current = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
