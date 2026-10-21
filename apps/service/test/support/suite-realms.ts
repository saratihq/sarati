import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// At most three ended suites outlive a last-resort GC in a full run, so six leaves room.
const MAX_RETAINED = 6;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as NodeJS.GCFunction;
setFlagsFromString('--no-expose-gc');

let ended: { testPath: string; realm: WeakRef<object> }[] = [];

/** Remembers a suite's realm as the suite ends, so a later suite can tell whether it was freed. */
export function suiteEnded(testPath: string, realm: object): void {
  ended.push({ testPath, realm: new WeakRef(realm) });
}

/** Fails, naming them, when more ended suites than {@link MAX_RETAINED} survive a last-resort GC. */
export async function assertEndedSuitesFreed(): Promise<void> {
  // A WeakRef keeps its target alive until the job that made or read it ends.
  await new Promise<void>((resolve) => setImmediate(resolve));
  gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  ended = ended.filter(({ realm }) => realm.deref() !== undefined);
  if (ended.length <= MAX_RETAINED) return;
  const retained = ended.map(({ testPath }) => testPath);
  ended = [];
  throw new Error(
    `${retained.length} ended e2e suites are still in memory after a last-resort GC, and at most ` +
      `${MAX_RETAINED} may be: ${retained.join(', ')}`,
  );
}
