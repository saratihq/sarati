import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VAULT CANARY — the constitution's "ONE definition site" rules, enforced.
 * Add a row here in the same PR as any new one-definition-site rule.
 */
const SRC = join(__dirname, '..');

/** Each load-bearing question, and the ONE file allowed to answer it. */
const SINGLE_DEFINITION = [
  // Constitution, "Rules of the vault" + ADR 0018 — which nodes are triggers.
  { symbol: 'isTriggerNode', definedIn: 'compiler/compile-ir.ts' },
  // Constitution #4 — "did the content change?" is answered ONLY by computeDiff.
  { symbol: 'computeDiff', definedIn: 'ir/diff.ts' },
] as const;

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFilesUnder(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('spec.ts')) out.push(path);
  }
  return out;
}

const sources = (): Array<{ rel: string; text: string }> =>
  tsFilesUnder(SRC).map((path) => ({ rel: path.slice(SRC.length + 1), text: readFileSync(path, 'utf8') }));

describe('vault: one definition site per load-bearing question', () => {
  it.each(SINGLE_DEFINITION)('$symbol is DEFINED only in $definedIn', ({ symbol, definedIn }) => {
    const definition = new RegExp(`(?:function|const)\\s+${symbol}\\b`);
    const definers = sources()
      .filter((f) => definition.test(f.text))
      .map((f) => f.rel);

    expect(definers).toEqual([definedIn]);
  });

  it.each(SINGLE_DEFINITION)('every caller of $symbol IMPORTS it', ({ symbol, definedIn }) => {
    // Call position only: a passing mention in prose is not a re-answer.
    const call = new RegExp(`\\b${symbol}\\s*\\(`);
    const imports = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`);
    const offenders = sources()
      .filter((f) => f.rel !== definedIn && call.test(f.text) && !imports.test(f.text))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  /**
   * Constitution #16: ten hand-rolled copies of this check once existed and one of them answered
   * differently, which is how a workflow you cannot read came to confirm its own existence. Deciding
   * it inline is the drift; `WorkflowAccessService.require` is the only place allowed to.
   */
  it('no route re-decides workflow access inline — it asks WorkflowAccessService', () => {
    // Loading a workflow AND deciding on it is the pattern; authorizing a CREATE has no workflow to
    // reach, so it legitimately asks `policy.can` on the org alone.
    const offenders = sources()
      .filter((f) => f.rel !== 'workflows/workflow-access.service.ts')
      .filter(
        (f) => /getWorkflowEntity\(|findOne\(WorkflowEntity/.test(f.text) && /policy\.can\(/.test(f.text),
      )
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  /**
   * Constitution #4's other half: byte-comparing two documents is banned — key order and
   * absent-vs-undefined make it answer a different question than `computeDiff`.
   */
  it('no document byte-comparison in the IR / workflow / MCP modules', () => {
    const byteCompare = /JSON\.stringify\([^)]*\)\s*[!=]==\s*JSON\.stringify\(/;
    const offenders = sources()
      .filter((f) => f.rel.startsWith('ir/') || f.rel.startsWith('workflows/') || f.rel.startsWith('mcp/'))
      .filter((f) => byteCompare.test(f.text))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });
});
