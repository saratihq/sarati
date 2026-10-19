import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VAULT CANARY — the constitution's "ONE definition site" rules, enforced.
 * Add a row here in the same PR as any new one-definition-site rule.
 */
const SRC = join(__dirname, '..');

/** Each load-bearing question, and the ONE file allowed to answer it. */
const SINGLE_DEFINITION = [
  // Constitution, "Rules of the vault" + — which nodes are triggers.
  { symbol: 'isTriggerNode', definedIn: 'compiler/compile-ir.ts' },
  // Constitution #4 — "did the content change?" is answered ONLY by computeDiff.
  { symbol: 'computeDiff', definedIn: 'ir/diff.ts' },
  // Constitution #17 — what `{{$account…}}` reads, and how it is filled.
  { symbol: 'fillAccountRefs', definedIn: 'runtime/account-ref.ts' },
  // Constitution #18 — which account a step runs as, which accounts serve an app, and which actions need one, or a one-click one.
  { symbol: 'decideRunAs', definedIn: 'connections/run-as-account.ts' },
  { symbol: 'providersServing', definedIn: 'connections/run-as-account.ts' },
  { symbol: 'actionNeedsAccount', definedIn: 'providers/sdk-actions.registry.ts' },
  { symbol: 'actionNeedsManagedAccount', definedIn: 'providers/sdk-actions.registry.ts' },
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

  /** Constitution #17: only the action router fills `{{$account…}}`, after the run has decided the account through `decideRunAs` (#18). */
  it('only the action router fills {{$account…}}', () => {
    const fills = sources()
      .filter((f) => f.rel !== 'runtime/account-ref.ts' && /\bfillAccountRefs\s*\(/.test(f.text))
      .map((f) => f.rel);

    expect(fills).toEqual(['providers/action-router.provider.ts']);
  });

  /** Constitution #17: a save's ref warnings are `refWarningsOf`'s alone, so no save path skips its account check. */
  it('only refWarningsOf lints a document for a save', () => {
    const linters = sources()
      .filter((f) => f.rel !== 'compiler/ref-lint.ts' && /\blintDataRefs\s*\(/.test(f.text))
      .map((f) => f.rel);

    expect(linters).toEqual(['compose/author-validation.ts']);
  });

  /** Constitution #18: nothing but the run-as rule looks up a slot or the runner's accounts for a step; a trigger's slot is read where it is stood up and promoted. */
  it('only the run-as rule picks the account a step runs as', () => {
    const pickers = sources()
      .filter((f) => /\.(?:resolveSlotConnection|resolveClusterConnection|accountsServing)\s*\(/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(pickers).toEqual([
      'connections/run-as-account.ts',
      'environments/env-slot-preflight.ts',
      'triggers/canvas/trigger-reconciler.service.ts',
    ]);
  });

  /** Constitution #18: every rail that runs a step in-process asks the rule, so no rail decides an account itself. */
  it('every in-process rail runs a step as the run-as rule decides', () => {
    const rails = ['providers/action-router.provider.ts', 'providers/agent-model-call.provider.ts'];
    const asking = sources()
      .filter((f) => /\b(?:resolveRunAs|decideRunAs)\s*\(/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(asking).toEqual(['connections/run-as-account.ts', ...rails]);
  });

  /** Constitution #15: a failing pre-merge test blocks a protected merge in `mergeBranchIn` alone, so no entry point can skip it. */
  it('only mergeBranchIn decides a merge on a pre-merge test', () => {
    const verdictChecks =
      /verdict\s*[!=]==?\s*['"](?:red|green)['"]|['"](?:red|green)['"]\s*[!=]==?\s*\S*verdict/;
    const readsResults = /FROM\s+review_test_results/i;
    const deciders = sources()
      .filter((f) => verdictChecks.test(f.text) || readsResults.test(f.text))
      .map((f) => f.rel);

    expect(deciders).toEqual(['workflows/branch.service.ts']);
  });

  /** Constitution #16: `WorkflowAccessService.require` is the only place allowed to decide it. */
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
