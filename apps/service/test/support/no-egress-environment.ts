import { relative } from 'node:path';

import type { Circus } from '@jest/types';
import { TestEnvironment } from 'jest-environment-node';

import { egressLedger, refusalReport, type SuiteEgress } from './no-egress';
import { assertEndedSuitesFreed, suiteEnded } from './suite-realms';

/** The e2e environment: egress past loopback fails the test, or suite, that tried; ended suites left in memory fail the next. */
export default class NoEgressEnvironment extends TestEnvironment {
  private readonly egress: SuiteEgress;
  private failed = false;

  constructor(...args: ConstructorParameters<typeof TestEnvironment>) {
    super(...args);
    this.egress = { testPath: relative(process.cwd(), args[1].testPath), unreported: [], finished: false };
  }

  override async setup(): Promise<void> {
    // Entered before the first await, so the runner's await carries it into every hook, test and timer of the suite.
    egressLedger().suites.enterWith(this.egress);
    await assertEndedSuitesFreed();
    return super.setup();
  }

  override async teardown(): Promise<void> {
    // Node keeps the process's first 250 fetch timings, each holding the suite whose fetch recorded it.
    performance.clearResourceTimings();
    // A failed test's error stays in jest's results, and keeps its suite in memory with it.
    if (this.egress.finished && !this.failed) suiteEnded(this.egress.testPath, this.global);
    return super.teardown();
  }

  handleTestEvent(event: Circus.Event, state: Circus.State): void {
    if (event.name === 'test_done') {
      this.report(event.test.errors);
      this.failed ||= event.test.errors.length > 0;
    } else if (isSuiteHookEnd(event) || event.name === 'run_finish') {
      this.report(state.unhandledErrors);
    }
    if (event.name === 'run_finish') {
      this.egress.finished = true;
      this.failed ||= state.unhandledErrors.length > 0;
    }
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
