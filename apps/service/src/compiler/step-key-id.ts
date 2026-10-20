// The characters step keys and op names are built from: an id holding one could name another node's step.
const STEP_KEY_CHARS = /[|/#:]/;

/** Refuse a node id that holds a character step keys are built from, before it can name another node's step. */
export function assertStepKeyId(id: string): void {
  if (STEP_KEY_CHARS.test(id)) {
    throw new Error(`Node id "${id}" can't contain "|", "/", "#" or ":" — they build its step's key`);
  }
}
