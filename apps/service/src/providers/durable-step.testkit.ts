import { PassThroughDurableStep, type DurableStep } from './durable-step';

/** The in-process substrate's primitives a test replaces, to see what a run sends through them or to answer it. */
export interface SubstratePrimitives {
  run?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  sleep?: (name: string, ms: number) => Promise<void>;
  receive?: (name: string, topic: string, timeoutMs: number) => Promise<unknown>;
}

/** Test support: today's in-process substrate, with the primitives given replaced. */
export function substrate(primitives: SubstratePrimitives): DurableStep {
  return new (class extends PassThroughDurableStep {
    override run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return primitives.run ? primitives.run(name, fn) : super.run(name, fn);
    }

    override sleep(name: string, ms: number): Promise<void> {
      return primitives.sleep ? primitives.sleep(name, ms) : super.sleep(name, ms);
    }

    override receive<T = unknown>(name: string, topic: string, timeoutMs: number): Promise<T | null> {
      return primitives.receive
        ? (primitives.receive(name, topic, timeoutMs) as Promise<T | null>)
        : super.receive<T>(name, topic, timeoutMs);
    }
  })();
}
