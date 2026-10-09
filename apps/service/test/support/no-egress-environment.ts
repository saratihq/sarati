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

  handleTestEvent(event: Circus.Event, state: Circus.State): void {
    if (event.name === 'test_done') {
      const refused = refusalReport(this.egress);
      if (refused) event.test.errors.push(refused);
    }
    if (event.name === 'run_finish') {
      const refused = refusalReport(this.egress);
      if (refused) state.unhandledErrors.push(refused);
      this.egress.finished = true;
    }
  }
}
