/** Minimal async mutex. Writes to one database are serialized in-process through this. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const registry = new Map<string, Mutex>();
export function mutexFor(key: string): Mutex {
  let m = registry.get(key);
  if (!m) {
    m = new Mutex();
    registry.set(key, m);
  }
  return m;
}
