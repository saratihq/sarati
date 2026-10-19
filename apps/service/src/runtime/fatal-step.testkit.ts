import { DeterminismError, PassThroughDurableStep } from '../providers/durable-step';

/** Test support: the in-process substrate raising a fatal error at the op of every step `at` names, never in its body. */
export class FatalStepDurable extends PassThroughDurableStep {
  constructor(
    private readonly at: (name: string) => boolean,
    private readonly afterMs = 0,
  ) {
    super();
  }

  override async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.at(name)) return super.run(name, fn);
    if (this.afterMs > 0) await new Promise((resolve) => setTimeout(resolve, this.afterMs));
    throw new DeterminismError(`fatal at ${name}`);
  }
}
