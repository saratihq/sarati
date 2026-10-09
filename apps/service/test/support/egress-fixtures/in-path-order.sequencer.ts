/** Runs fixture suites in path order, so the suite that leaks a timer is followed by one that outlives it. */
export default class InPathOrder {
  sort<T extends { path: string }>(tests: T[]): T[] {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }

  cacheResults(): void {}
}
