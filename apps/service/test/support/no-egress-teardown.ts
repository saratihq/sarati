import { egressLedger } from './no-egress';

/** Fails the run on egress no suite could report — a timer or poll that outlived the suite that started it. */
export default function reportStrayEgress(): void {
  const strays = egressLedger().strays.splice(0);
  if (strays.length > 0) {
    throw new Error(`e2e egress refused: ${strays.join('; ')} — e2e suites must stay on loopback`);
  }
}
