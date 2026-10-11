import type { Config } from '@jest/types';

import { installedLedger, strayReport } from './no-egress';

/** Fails the run on egress no suite could report — a timer or poll that outlived the suite that started it. */
export default function reportStrayEgress(globalConfig: Config.GlobalConfig): void {
  const ledger = installedLedger();
  if (!ledger) {
    // Suites in worker processes keep their strays there, where nothing reads them.
    if (globalConfig.maxWorkers > 1) {
      throw new Error('the e2e egress check needs the suites in band — run with --runInBand or maxWorkers 1');
    }
    return;
  }
  const report = strayReport(ledger.strays.splice(0));
  if (report !== null) throw new Error(report);
}
