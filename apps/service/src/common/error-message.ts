/** The message of any thrown value. Import this rather than re-inlining the `instanceof Error` ternary. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
