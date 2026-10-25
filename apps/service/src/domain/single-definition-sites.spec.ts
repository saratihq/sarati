import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

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
  { symbol: 'decideBySlot', definedIn: 'connections/run-as-account.ts' },
  // Constitution #11 — how a trigger is stood up, and which triggers listen as their environment's slot.
  { symbol: 'activationKindOf', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'listensAsAccount', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'listensAsManagedAccount', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'triggerSlotOf', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'decideTriggerSlots', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'heldBackBySlot', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'firesWhileHeld', definedIn: 'triggers/canvas/trigger-kind.ts' },
  { symbol: 'holdsTrigger', definedIn: 'triggers/canvas/activation-row.ts' },
  { symbol: 'servedWebhookUrl', definedIn: 'triggers/canvas/webhook-url.ts' },
  { symbol: 'sameWebhookIntake', definedIn: 'triggers/canvas/webhook-url.ts' },
] as const;

// Calls whose direct arguments are SQL or query criteria: a raw query, the raw-query helpers, and TypeORM's query builder and criteria methods.
const QUERY_CALLS = new Set([
  'query',
  'rawQuery',
  'rawMutate',
  'rawMutateReturning',
  'where',
  'andWhere',
  'orWhere',
  'having',
  'andHaving',
  'orHaving',
  'select',
  'addSelect',
  'orderBy',
  'addOrderBy',
  'groupBy',
  'addGroupBy',
  'innerJoin',
  'leftJoin',
  'innerJoinAndSelect',
  'leftJoinAndSelect',
  'findBy',
  'findOneBy',
  'findOneByOrFail',
  'findAndCountBy',
  'countBy',
  'existsBy',
  'sum',
  'average',
  'minimum',
  'maximum',
  'delete',
  'softDelete',
  'restore',
  'increment',
  'decrement',
]);
const SQL_STATEMENT =
  /\bselect\b[\s\S]*\bfrom\b|\bupdate\s+\S+[\s\S]*\bset\b|\bdelete\s+from\b|\binsert\s+into\b/i;
// The column bare, quoted or behind an alias, in any case; never a quoted value ('held') or a longer name.
const HELD_COLUMN = /(?<![\w$'])(?:"?\w+"?\.)?"?held"?(?![\w$'])/i;

function callName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : '';
}

// The SQL text of a string, a template's literal parts or a `+` join of them; undefined for anything else.
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ? ');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${literalText(node.left) ?? ' ? '}${literalText(node.right) ?? ' ? '}`;
  }
  return undefined;
}

const keyName = (name: ts.PropertyName): string => name.getText().replace(/[[\]'"`]/g, '');
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

// Whether `node` hands `from` on unchanged as criteria: an object or array, a property, a spread, parentheses, a cast, `!`, a conditional's branch, or either side of `&&`, `||` or `??`.
function handsOn(node: ts.Node, from: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) return node.condition !== from;
  if (ts.isBinaryExpression(node)) return LOGICAL.has(node.operatorToken.kind);
  return (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isSpreadAssignment(node) ||
    ts.isSpreadElement(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

// Whether a `held` key sits in query criteria: under a `where`, or in an object handed to a criteria call, through whatever hands it on.
function inCriteria(key: ts.Node): boolean {
  for (let at: ts.Node = key; at.parent; at = at.parent) {
    const up = at.parent;
    if (ts.isCallExpression(up) && up.arguments.some((a) => a === at)) {
      const name = callName(up);
      return QUERY_CALLS.has(name) || (name === 'update' && up.arguments.at(-1) !== at);
    }
    if (ts.isPropertyAssignment(up) && keyName(up.name) === 'where') return true;
    if (!handsOn(up, at)) return false;
  }
  return false;
}

// Where a source's SQL or query criteria names an activation's `held` column, as `line: text`.
function heldInQueries(text: string): string[] {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node): string =>
    `${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText().slice(0, 80)}`;
  const visit = (node: ts.Node): void => {
    const isPart =
      ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const sql = isPart ? undefined : literalText(node);
    const handed =
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.some((a) => a === node) &&
      QUERY_CALLS.has(callName(node.parent));
    if (sql !== undefined && (handed || SQL_STATEMENT.test(sql)) && HELD_COLUMN.test(sql))
      found.push(at(node));
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      keyName(node.name) === 'held' &&
      inCriteria(node)
    ) {
      found.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

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

  /** Constitution #11: the reconciler and the promote preflight ask one judgement which triggers listen as a slot, by one predicate and #18's slot rule. */
  it('a trigger listens as the slot one predicate names, judged by the run-as slot rule', () => {
    const asking = (call: RegExp, definedIn: string): string[] =>
      sources()
        .filter((f) => f.rel !== definedIn && call.test(f.text))
        .map((f) => f.rel)
        .sort();
    const listeners = ['environments/env-slot-preflight.ts', 'triggers/canvas/trigger-reconciler.service.ts'];
    const kindSite = 'triggers/canvas/trigger-kind.ts';
    const runtime = ['triggers/canvas/trigger-reconciler.service.ts', 'triggers/triggers.service.ts'];

    expect(asking(/\bdecideTriggerSlots\s*\(/, kindSite)).toEqual(listeners);
    expect(asking(/\btriggerSlotOf\s*\(/, kindSite)).toEqual([]);
    expect(asking(/\bdecideBySlot\s*\(/, 'connections/run-as-account.ts')).toEqual([kindSite]);
    expect(asking(/\bheldBackBySlot\s*\(/, kindSite)).toEqual(runtime);
    expect(asking(/\bfiresWhileHeld\s*\(/, kindSite)).toEqual(runtime);
    expect(asking(/\bholdsTrigger\s*\(/, 'triggers/canvas/activation-row.ts')).toEqual(runtime);
    // SQL or query criteria naming an activation's `held` column would answer heldBackBySlot where the callers above can't see it.
    const naming = sources()
      .map((f) => ({ rel: f.rel, at: heldInQueries(f.text) }))
      .filter((f) => f.at.length > 0);
    expect(naming).toEqual([]);
  });

  /** Constitution #11: the guard above reads the `held` column in every form of SQL and query criteria listed in row 11. */
  it('finds the held column in SQL and query criteria in any case, quoting, alias, expression or wrapper, and not in values, copy or parameters', () => {
    const sql = (statement: string): string => `rawMutateReturning(em, \`${statement}\`, [id]);`;
    const named = [
      sql(
        'UPDATE runtime_trigger_activations SET x = CASE WHEN held OR connection_id IS NULL THEN x ELSE $3 END',
      ),
      sql(
        'update runtime_trigger_activations set x = case when held or connection_id is null then x else $3 end',
      ),
      sql('UPDATE runtime_trigger_activations SET x = CASE WHEN (held = true) THEN x END'),
      sql('UPDATE runtime_trigger_activations SET x = CASE WHEN COALESCE(held, false) THEN x END'),
      sql('UPDATE runtime_trigger_activations a SET x = 1 WHERE a.paused = false AND (a.held = false)'),
      sql('SELECT count(*) filter (where held) FROM runtime_trigger_activations'),
      sql('SELECT CASE held WHEN true THEN 1 END FROM runtime_trigger_activations'),
      sql('SELECT 1 FROM runtime_trigger_activations a WHERE a."HELD"'),
      "qb.andWhere('a.held = false');",
      "qb.where(`a.${'x'} = 1 AND a.held`);",
      "const statement = 'SELECT id FROM runtime_trigger_activations WHERE held';",
      "client.query('SELECT id FROM runtime_trigger_activations WHERE ' + 'held');",
      'em.find(RuntimeTriggerActivationEntity, { where: { paused: false, held: false } });',
      'em.find(RuntimeTriggerActivationEntity, { where: [{ held }] });',
      'em.findBy(RuntimeTriggerActivationEntity, { held: true });',
      "em.update(RuntimeTriggerActivationEntity, { id, 'held': false }, { lastError });",
      'qb.where({ held: false });',
      "em.find(RuntimeTriggerActivationEntity, { 'where': { ['held']: true } });",
      'em.find(RuntimeTriggerActivationEntity, { where: live ? { paused: false, held: false } : { paused: false } });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false } as FindOptionsWhere<Activation> });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false } satisfies FindOptionsWhere<Activation> });',
      'em.find(RuntimeTriggerActivationEntity, { where: <FindOptionsWhere<Activation>>{ held: false } });',
      'em.find(RuntimeTriggerActivationEntity, { where: ({ held: false }) });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false }! });',
      'em.find(RuntimeTriggerActivationEntity, { where: { paused: false, ...(live && { held: false }) } });',
      'em.find(RuntimeTriggerActivationEntity, { where: { paused: false, ...(live ? { held: false } : {}) } });',
      'em.find(RuntimeTriggerActivationEntity, { where: [...(live ? [{ held: false }] : [])] });',
      'em.find(RuntimeTriggerActivationEntity, { where: given ?? { held: false } });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false } ?? given });',
      'em.find(RuntimeTriggerActivationEntity, { where: given || { held: false } });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false } || given });',
      'em.find(RuntimeTriggerActivationEntity, { where: { held: false } && given });',
      'em.find(RuntimeTriggerActivationEntity, { where: live ? { paused: false } : { held: false } });',
      'em.find(WorkflowEntity, { where: { activation: { held: true } } });',
      'em.update(RuntimeTriggerActivationEntity, live ? { id, held: false } : { id }, { lastError });',
    ];
    const unnamed = [
      "client.query(\"SELECT 1 FROM information_schema.columns WHERE table_name='runtime_trigger_activations' AND column_name='held'\");",
      'heldBackBySlot({ ...actualOf(row), held: row.held });',
      'em.create(RuntimeTriggerActivationEntity, { id, held: false });',
      'em.update(RuntimeTriggerActivationEntity, { id }, { held: true, lastError });',
      'logger.warn(`composio intake: held activation ${id} did not fire`);',
      "const copy = `${env}'s account isn't active, so it is held: what it sends still starts runs`;",
      sql('SELECT held_back, withheld FROM runtime_trigger_activations'),
      "qb.where('a.id = :id', { id: 'held' });",
      'em.update(RuntimeTriggerActivationEntity, { id }, live ? { held: true } : { lastError });',
      'const shown = live ? { held: true } : {};',
      'em.find(RuntimeTriggerActivationEntity, { where: (given ?? { held: true }) ? { id } : { paused: false } });',
    ];

    expect(named.filter((source) => heldInQueries(source).length !== 1)).toEqual([]);
    expect(unnamed.filter((source) => heldInQueries(source).length !== 0)).toEqual([]);
  });

  /** Constitution #11: the URL a webhook is served at and the intake a URL reaches are each built in one place, so the held reason and the health read cannot disagree. */
  it('builds a webhook URL from the public base URL, and compares intakes, in one place', () => {
    const callers = (symbol: string): string[] =>
      sources()
        .filter(
          (f) => f.rel !== 'triggers/canvas/webhook-url.ts' && new RegExp(`\\b${symbol}\\s*\\(`).test(f.text),
        )
        .map((f) => f.rel)
        .sort();
    const readers = sources()
      .filter((f) => /\bpublicBaseUrl\b/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(callers('servedWebhookUrl')).toEqual([
      'triggers/canvas/trigger-reconciler.service.ts',
      'triggers/triggers.service.ts',
    ]);
    expect(callers('sameWebhookIntake')).toEqual(['triggers/canvas/activation-row.ts']);
    expect(readers).toEqual(['config/env.config.ts', 'triggers/canvas/webhook-url.ts']);
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

  /** Constitution #21: who may change what an environment runs is one answer, and a branch test under one asks it too. */
  it('every pointer move, and a branch test under an environment, asks the one promote decision', () => {
    const asking = sources()
      .filter((f) => /\.(?:assertMayPromote|promoteRightMissing)\s*\(/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(asking).toEqual([
      'reviews/review-test.service.ts',
      'workflows/env-pointers.service.ts',
      'workflows/versions-write.service.ts',
      'workflows/workflow-lifecycle.service.ts',
    ]);
  });

  /** Constitution #19: a recorded history is replayed as it ran, never patched into another one. */
  it('no module patches a durable workflow', () => {
    const offenders = sources()
      .filter((f) => f.text.includes('@dbos-inc/dbos-sdk') && /\b(patch|deprecatePatch)\s*\(/.test(f.text))
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
