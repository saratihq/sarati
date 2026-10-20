import { relative } from 'node:path';

import type { Circus } from '@jest/types';
import { TestEnvironment } from 'jest-environment-node';

import { egressLedger, refusalReport, type SuiteEgress } from './no-egress';

/** The e2e environment: a suite that reaches past loopback fails the test, or the suite, that tried. */
export default class NoEgressEnvironment extends TestEnvironment {
  private readonly egress: SuiteEgress;

  constructor(...args: ConstructorParameters<typeof TestEnvironment>) {
    super(...args);
    this.egress = { testPath: relative(process.cwd(), args[1].testPath), unreported: [], finished: false };
  }

  override setup(): Promise<void> {
    // Entered before the first await, so the runner's await carries it into every hook, test and timer of the suite.
    egressLedger().suites.enterWith(this.egress);
    return super.setup();
  }

  override async teardown(): Promise<void> {
    // Node keeps the process's first 250 fetch timings, each holding the suite whose fetch recorded it.
    performance.clearResourceTimings();
    return super.teardown();
  }

  handleTestEvent(event: Circus.Event, state: Circus.State): void {
    if (event.name === 'test_done') this.report(event.test.errors);
    else if (isSuiteHookEnd(event) || event.name === 'run_finish') this.report(state.unhandledErrors);
    if (event.name === 'run_finish') this.egress.finished = true;
  }

  private report(into: unknown[]): void {
    const refused = refusalReport(this.egress);
    if (refused) into.push(refused);
  }
}

// A beforeAll or afterAll belongs to no test, so what it reaches for fails the suite rather than the next test.
function isSuiteHookEnd(event: Circus.Event): boolean {
  return (
    (event.name === 'hook_success' || event.name === 'hook_failure') &&
    (event.hook.type === 'beforeAll' || event.hook.type === 'afterAll')
  );
}
