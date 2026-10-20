import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

/**
 * VAULT CANARY — constitution #11: a write to a table a workflow delete reaches runs in a transaction that takes the
 * workflow row before anything else, or is listed here with why it need not. A canary for new writers, not a proof:
 * the forms it reads and the ones it cannot are listed in row 11, and anything it cannot classify fails.
 */
const SERVICE = join(__dirname, '..', '..');
const APPS = [
  { app: 'service', dir: SERVICE },
  { app: 'agent', dir: join(SERVICE, '..', 'agent') },
];
const SCHEMA = join(SERVICE, 'db', 'schema.sql');

const CREATES = 'creates the workflow, which nothing else can reach before it commits';
const ACTIVATION =
  "an activation's own row or store, under its advisory lock; a workflow delete is refused while any activation is left";
const ACTIVATION_RECORD =
  "an activation's own row, written only over the row as it read it (its xmin); a workflow delete is refused while any activation is left";
const ACTIVATION_FAILURE =
  "an activation's own row, recording an apply that failed once its lock was released; a workflow delete is refused while any activation is left";
const ENV_POINTERS =
  "an environment's pointers: it locks the env row or only the pointer rows, never a workflow row, and a workflow delete is refused while any pointer is left";
const RUN_HISTORY =
  "one statement on a run's history row; a workflow delete only clears its workflow_id, and it holds no lock before its foreign-key check";
const RUN_LOCK =
  "a run's own rows under that run's row lock, taken first, updating the run's row at most once; nothing in it reaches the workflow row, so a workflow delete waiting on the run's row only waits for it to commit, never a cycle";
const THREAD =
  'one autocommit statement on a thread row: it holds no other lock while it waits, so it finishes before a workflow delete or waits for it, never a cycle';

/** The writes that take no workflow-row lock, as `app:file#member#table`, the one context each may run in, and why that is safe. */
const UNLOCKED: Record<string, { in: 'autocommit' | 'transaction'; why: string }> = {
  'service:workflows/workflow-lifecycle.service.ts#createDraft#workflow_branches': {
    in: 'transaction',
    why: CREATES,
  },
  'service:workflows/workflow-lifecycle.service.ts#deployCreateOnSarati#workflow_versions': {
    in: 'transaction',
    why: CREATES,
  },
  'service:workflows/workflow-lifecycle.service.ts#deployCreateOnSarati#workflow_branches': {
    in: 'transaction',
    why: CREATES,
  },
  'service:workflows/workflow-lifecycle.service.ts#deployCreateOnSarati#workflow_version_tags': {
    in: 'transaction',
    why: CREATES,
  },
  'service:workflows/workflow-lifecycle.service.ts#deployCreateOnSarati#workflow_env_pointers': {
    in: 'transaction',
    why: CREATES,
  },
  'service:environments/environments.service.ts#rename#workflow_env_pointers': {
    in: 'transaction',
    why: ENV_POINTERS,
  },
  'service:environments/environments.service.ts#unpromoteAll#workflow_env_pointers': {
    in: 'transaction',
    why: ENV_POINTERS,
  },
  'service:triggers/activation-store.ts#put#runtime_activation_store': { in: 'autocommit', why: ACTIVATION },
  'service:triggers/activation-store.ts#delete#runtime_activation_store': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/activation-store.ts#clear#runtime_activation_store': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/triggers.service.ts#fireComposioActivation#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION_RECORD,
  },
  'service:triggers/triggers.service.ts#pollLockedActivation#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#applyFailed#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION_FAILURE,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#applyUpdate#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#applyDelete#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#recordMaterialized#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#subscribeComposio#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#compensateIfOrphaned#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#unsubscribeComposio#runtime_trigger_activations': {
    in: 'transaction',
    why: ACTIVATION,
  },
  'service:triggers/canvas/trigger-reconciler.service.ts#recordError#runtime_trigger_activations': {
    in: 'autocommit',
    why: ACTIVATION,
  },
  'service:runtime/run-recorder.service.ts#insertRun#runtime_runs': { in: 'autocommit', why: RUN_HISTORY },
  'service:runtime/run-recorder.service.ts#stepResumed#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:runtime/run-recorder.service.ts#runFinished#runtime_runs': { in: 'autocommit', why: RUN_HISTORY },
  'service:runtime/run-recorder.service.ts#withRunLock#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:runtime/run-recorder.service.ts#withWaitLock#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:runtime/run-recorder.service.ts#runUnwoundByCancel#runtime_runs': {
    in: 'autocommit',
    why: RUN_HISTORY,
  },
  'service:runs/run-reaper.service.ts#reapCrashedRuns#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:runs/run-reaper.service.ts#reapLapsedWaits#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:runs/run-reaper.service.ts#reapStrandedDecisions#runtime_runs': {
    in: 'transaction',
    why: RUN_LOCK,
  },
  'service:runs/runs.service.ts#cancelRun#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'service:dbos/recovery-guard.ts#admit#runtime_runs': { in: 'transaction', why: RUN_LOCK },
  'agent:composer/thread-store.ts#resolve#composer_threads': { in: 'autocommit', why: THREAD },
  'agent:composer/thread-store.ts#deleteThread#composer_threads': { in: 'autocommit', why: THREAD },
  'agent:composer/thread-store.ts#append#composer_thread_events': { in: 'autocommit', why: THREAD },
  'agent:composer/thread-store.ts#append#composer_threads': { in: 'autocommit', why: THREAD },
  'agent:composer/thread-store.ts#recordSdkSession#composer_threads': { in: 'autocommit', why: THREAD },
};

/** Helpers that send on SQL their callers wrote, judged where it is written: on the caller's first argument, or in autocommit. */
const PASS_THROUGH: Record<string, 'first argument' | 'autocommit'> = {
  'service:database/raw-query.ts#rawQuery': 'first argument',
  'service:database/raw-query.ts#rawMutate': 'first argument',
  'service:database/raw-query.ts#rawMutateReturning': 'first argument',
  'service:runtime/run-recorder.service.ts#write': 'autocommit',
};

/** Members that send SQL this cannot read, and why it writes nothing under a workflow. */
const OPAQUE_READS: Record<string, string> = {
  'service:database/schema-guard.ts#onApplicationBootstrap':
    "runs this file's canary probes, every one a SELECT",
  'service:dbos/recovery-guard.ts#legacyRuns': "sends alreadyEnded's read of a run's status, a SELECT",
  'service:dbos/recovery-guard.ts#resumability':
    "sends readResumability's reads of a run's history, every one a SELECT",
  'service:scripts/legacy-report.cli.ts#main':
    "sends readResumability's reads of a run's history, every one a SELECT",
};

/** Where each workflow-row lock is defined, so a look-alike of the same name is not taken for it. */
const LOCKS: Record<string, string> = {
  lockWorkflowForWrite: 'workflows/workflow-row-lock.ts',
  lockWorkflowForPointerMove: 'workflows/workflow-row-lock.ts',
  lockWorkflowRow: 'workflows/workflow-row-lock.ts',
  lockDeletable: 'triggers/trigger-release.ts',
};

const POINTERS = 'workflow_env_pointers';
const INTERPOLATED = 'INTERPOLATED_NAME';
const SQL_WRITE =
  /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|lock(?:\s+table)?)\s+(?:only\s+)?(?:"?public"?\.)?("?)(\w+)\2/gi;
const ROW_LOCK = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;
const SQL_READ = /\b(?:from|join)\s+(?:only\s+)?(?:"?public"?\.)?("?)(\w+)\1/gi;
const LOCK_SQL = /^\s*SELECT 1 FROM workflows WHERE id = \$\d+ FOR (?:KEY SHARE|NO KEY UPDATE)\s*$/i;
const ORM_WRITES = new Set([
  'save',
  'insert',
  'update',
  'delete',
  'upsert',
  'remove',
  'softDelete',
  'softRemove',
  'restore',
  'recover',
  'increment',
  'decrement',
  'clear',
]);
const BUILDER_WRITES = new Set([
  'InsertQueryBuilder',
  'UpdateQueryBuilder',
  'DeleteQueryBuilder',
  'SoftDeleteQueryBuilder',
]);
const CONNECTIONS = new Set(['DataSource', 'EntityManager', 'Pool', 'PoolClient', 'Client', 'QueryRunner']);

/** The tables a workflow delete deletes, updates or checks: the closure of foreign keys onto `workflows`, cascades followed. */
function tablesUnderWorkflow(schema: string): Set<string> {
  const edges: Array<{ child: string; parent: string; cascades: boolean }> = [];
  const fk =
    /FOREIGN KEY \([\w, ]+\) REFERENCES public\.(\w+)\([\w, ]+\)(?: ON UPDATE \w+(?: \w+)?)?(?: ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION))?/g;
  const add = (child: string, body: string): void => {
    for (const [, parent, action] of body.matchAll(fk)) {
      edges.push({ child, parent: parent!, cascades: action === 'CASCADE' });
    }
  };
  for (const [, child, body] of schema.matchAll(
    /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ (FOREIGN KEY[^;]+)/g,
  )) {
    add(child!, body!);
  }
  for (const [, child, body] of schema.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+) \(([\s\S]*?)\n\);/g,
  )) {
    add(child!, body!);
  }
  const reached = new Set<string>();
  const expanded = new Set<string>(['workflows']);
  const pending = ['workflows'];
  for (let next = pending.pop(); next; next = pending.pop()) {
    for (const edge of edges.filter((e) => e.parent === next && e.child !== 'workflows')) {
      reached.add(edge.child);
      if (edge.cascades && !expanded.has(edge.child)) {
        expanded.add(edge.child);
        pending.push(edge.child);
      }
    }
  }
  return reached;
}

type Context =
  | { kind: 'transaction'; opener: 'row' | 'pointer' | null }
  | { kind: 'parameter'; fn: ts.SignatureDeclaration; index: number }
  | { kind: 'autocommit' }
  | { kind: 'manual' }
  | { kind: 'unknown'; why: string };

interface App {
  app: string;
  src: string;
  checker: ts.TypeChecker;
  files: ts.SourceFile[];
  entities: Map<string, string>;
  transactions: Map<ts.Node, 'row' | 'pointer' | null>;
}

interface Verdict {
  offenders: string[];
  exempted: Set<string>;
  transactions: string[];
  byHand: string[];
}

function load(app: string, dir: string): App {
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(dir, 'tsconfig.json'), (path) => ts.sys.readFile(path)).config,
    ts.sys,
    dir,
  );
  const src = join(dir, 'src');
  const roots = config.fileNames.filter((f) => f.startsWith(src) && !f.endsWith('.spec.ts'));
  const program = ts.createProgram(roots, config.options, ts.createCompilerHost(config.options, true));
  const files = program.getSourceFiles().filter((f) => roots.includes(f.fileName));
  const entities = new Map<string, string>();
  for (const file of files) {
    ts.forEachChild(file, (node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || call.expression.getText() !== 'Entity') continue;
        const [arg] = call.arguments;
        const name =
          arg && ts.isStringLiteral(arg)
            ? arg.text
            : arg && ts.isObjectLiteralExpression(arg)
              ? stringProperty(arg, 'name')
              : undefined;
        if (name) entities.set(node.name.text, name);
      }
    });
  }
  return { app, src, checker: program.getTypeChecker(), files, entities, transactions: new Map() };
}

function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === key &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isAwaitExpression(expression) ||
  ts.isParenthesizedExpression(expression) ||
  ts.isNonNullExpression(expression)
    ? unwrap(expression.expression)
    : expression;

const resolved = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
};

/** The named member a node sits in: its method, function, or the property or module variable that holds it. */
function memberOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isConstructorDeclaration(at)) return 'constructor';
    if (
      (ts.isMethodDeclaration(at) ||
        ts.isFunctionDeclaration(at) ||
        ts.isPropertyDeclaration(at) ||
        ts.isGetAccessorDeclaration(at)) &&
      at.name
    ) {
      return at.name.getText();
    }
    if (ts.isVariableDeclaration(at) && ts.isSourceFile(at.parent.parent.parent)) return at.name.getText();
  }
  return '';
}

// A type is `kind` when it, one of its union or intersection members, or one of its base types is named so.
function typeOfKind(
  checker: ts.TypeChecker,
  type: ts.Type,
  kind: (name: string) => boolean,
  seen = new Set<ts.Type>(),
): ts.Type | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);
  const name = (type.getSymbol() ?? type.aliasSymbol)?.getName();
  if (name && kind(name)) return type;
  const parts = type.isUnionOrIntersection()
    ? type.types
    : type.isClassOrInterface()
      ? (checker.getBaseTypes(type) ?? [])
      : [];
  for (const part of parts) {
    const found = typeOfKind(checker, part, kind, seen);
    if (found) return found;
  }
  const target = (type as ts.TypeReference).target;
  return target && target !== type && target.isClassOrInterface()
    ? checker
        .getBaseTypes(target)
        .map((base) => typeOfKind(checker, base, kind, seen))
        .find(Boolean)
    : undefined;
}

const kindOf = (
  checker: ts.TypeChecker,
  node: ts.Node,
  kind: (name: string) => boolean,
): ts.Type | undefined =>
  typeOfKind(checker, checker.getNonNullableType(checker.getTypeAtLocation(node)), kind);

// The table of an entity type; undefined for anything that is not a known entity, a type parameter included.
function tableOfType(app: App, type: ts.Type | undefined): string | undefined {
  if (!type || type.flags & ts.TypeFlags.TypeParameter) return undefined;
  const plain = app.checker.getNonNullableType(type);
  const element = app.checker.isArrayType(plain)
    ? app.checker.getTypeArguments(plain as ts.TypeReference)[0]
    : plain;
  const name = element?.getSymbol()?.getName();
  return name ? app.entities.get(name) : undefined;
}

// The table an entity class or instance expression names.
function entityTable(app: App, expression: ts.Expression): string | undefined {
  const symbol = resolved(app.checker, expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Class) return app.entities.get(symbol.getName());
  return tableOfType(app, app.checker.getTypeAtLocation(expression));
}

// The table of a repository or query builder, from its entity type argument.
function typeArgumentTable(app: App, type: ts.Type | undefined): string | undefined {
  const [argument] = type ? app.checker.getTypeArguments(type as ts.TypeReference) : [];
  return tableOfType(app, argument);
}

const locksRows = (call: ts.CallExpression): boolean =>
  call.arguments.some(
    (a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) => p.name?.getText() === 'lock'),
  );

// A query builder's target table and the manager its chain starts from, through any variable holding part of it.
function builderTarget(
  app: App,
  receiver: ts.Expression,
): { table: string | undefined; manager: ts.Expression } {
  let table = typeArgumentTable(
    app,
    kindOf(app.checker, receiver, (n) => n.endsWith('QueryBuilder')),
  );
  for (let at = unwrap(receiver); ;) {
    if (ts.isIdentifier(at)) {
      const declaration = app.checker.getSymbolAtLocation(at)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) break;
      at = unwrap(declaration.initializer);
      continue;
    }
    if (!ts.isCallExpression(at) || !ts.isPropertyAccessExpression(at.expression)) break;
    const name = at.expression.name.text;
    const [target] = at.arguments;
    if (
      ['into', 'update', 'from', 'createQueryBuilder', 'getRepository'].includes(name) &&
      target &&
      !ts.isStringLiteral(target)
    ) {
      table = entityTable(app, target) ?? table;
    }
    if (name === 'createQueryBuilder') return { table, manager: at.expression.expression };
    at = unwrap(at.expression.expression);
  }
  return { table: undefined, manager: receiver };
}

/** The guarded table an ORM call writes or locks, with the manager it runs on; one it cannot attribute is refused as `?`. */
function ormWrite(
  app: App,
  node: ts.Node,
  guarded: Set<string>,
): { table: string; manager: ts.Expression } | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const { checker } = app;
  const method = node.expression.name.text;
  const receiver = node.expression.expression;
  const manager = kindOf(checker, receiver, (n) => n === 'EntityManager');
  const repository = kindOf(checker, receiver, (n) => n === 'Repository');
  let target: { table: string | undefined; manager: ts.Expression } | undefined;
  if (manager && (ORM_WRITES.has(method) || (method.startsWith('find') && locksRows(node)))) {
    target = {
      table: node.arguments[0] ? entityTable(app, node.arguments[0]) : undefined,
      manager: receiver,
    };
  } else if (repository && (ORM_WRITES.has(method) || (method.startsWith('find') && locksRows(node)))) {
    target = { table: typeArgumentTable(app, repository), manager: receiver };
  } else if (
    (method === 'execute' && kindOf(checker, receiver, (n) => BUILDER_WRITES.has(n))) ||
    (method === 'setLock' && kindOf(checker, receiver, (n) => n.endsWith('QueryBuilder')))
  ) {
    target = builderTarget(app, receiver);
  }
  if (!target) return undefined;
  if (target.table === undefined) return { table: '?', manager: target.manager };
  return guarded.has(target.table) ? { table: target.table, manager: target.manager } : undefined;
}

/** The text of a SQL-bearing expression, every non-literal part replaced by a marker; undefined when it is not one. */
function sqlText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => `${INTERPOLATED}${s.literal.text}`).join('');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const part = (side: ts.Expression): string => sqlText(side) ?? INTERPOLATED;
    return part(node.left) + part(node.right);
  }
  return undefined;
}

/** Reads every source file of an app and judges each write to a guarded table. */
function judge(app: App, guarded: Set<string>): Verdict {
  const { checker } = app;
  const verdict: Verdict = { offenders: [], exempted: new Set(), transactions: [], byHand: [] };
  const relative = (node: ts.Node): string => node.getSourceFile().fileName.slice(app.src.length + 1);
  const where = (node: ts.Node): string =>
    `${app.app}:${relative(node)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const memberKey = (node: ts.Node): string => `${app.app}:${relative(node)}#${memberOf(node)}`;
  const declarationKey = (symbol: ts.Symbol | undefined): string | undefined => {
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && 'name' in declaration && declaration.name
      ? `${app.app}:${declaration.getSourceFile().fileName.slice(app.src.length + 1)}#${(declaration.name as ts.Node).getText()}`
      : undefined;
  };

  // The lock a transaction's first statement takes on that transaction's own manager; null when it takes none.
  const openerOf = (body: ts.Block, manager: string): 'row' | 'pointer' | null => {
    const [first] = body.statements;
    let call: ts.Expression | undefined;
    if (first && ts.isExpressionStatement(first) && ts.isAwaitExpression(first.expression)) {
      call = first.expression.expression;
    } else if (
      first &&
      ts.isIfStatement(first) &&
      ts.isPrefixUnaryExpression(first.expression) &&
      ts.isParenthesizedExpression(first.expression.operand) &&
      ts.isAwaitExpression(first.expression.operand.expression)
    ) {
      call = first.expression.operand.expression.expression;
    }
    if (!call || !ts.isCallExpression(call) || call.arguments[0]?.getText() !== manager) return null;
    const lock = resolved(checker, call.expression);
    const name = lock?.getName() ?? '';
    const home = lock?.valueDeclaration?.getSourceFile().fileName.slice(join(SERVICE, 'src').length + 1);
    if (!LOCKS[name] || LOCKS[name] !== home) return null;
    if (ts.isIfStatement(first!) !== (name === 'lockWorkflowRow')) return null;
    if (name === 'lockWorkflowForPointerMove') return 'pointer';
    if (name !== 'lockDeletable') return 'row';
    const [, target] = call.arguments;
    return target &&
      ts.isObjectLiteralExpression(target) &&
      target.properties.some((p) => p.name?.getText() === 'workflowId')
      ? 'row'
      : null;
  };

  for (const file of app.files) {
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      if (method === 'createQueryRunner' || method === 'startTransaction') verdict.byHand.push(where(node));
      if (
        method !== 'transaction' ||
        !kindOf(checker, node.expression.expression, (n) => n === 'DataSource' || n === 'EntityManager')
      )
        return;
      const callback = node.arguments.at(-1);
      const inline =
        callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? callback
          : undefined;
      const param = inline?.parameters[0]?.name;
      if (!inline || !param || !ts.isIdentifier(param) || !ts.isBlock(inline.body)) {
        verdict.transactions.push(where(node));
        return;
      }
      app.transactions.set(inline, openerOf(inline.body, param.text));
    });
  }

  // Where a manager's statements run: in a transaction, on a caller's manager, in autocommit, or in a hand-run transaction.
  const classify = (expression: ts.Expression): Context => {
    const at = unwrap(expression);
    const unknown = { kind: 'unknown' as const, why: `a manager this cannot place: ${at.getText()}` };
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression)) {
      const name = at.expression.name.text;
      if (name === 'connect') return { kind: 'manual' };
      if (name === 'getRepository' || name === 'createQueryBuilder')
        return classify(at.expression.expression);
    }
    if (ts.isIdentifier(at)) {
      const declaration = checker.getSymbolAtLocation(at)?.valueDeclaration;
      if (declaration && ts.isParameter(declaration)) {
        const fn = declaration.parent;
        const opener = app.transactions.get(fn);
        if (opener !== undefined) return { kind: 'transaction', opener };
        return { kind: 'parameter', fn, index: fn.parameters.indexOf(declaration) };
      }
      return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        ? classify(declaration.initializer)
        : unknown;
    }
    // The app's connection itself: the data source, a pool, a repository, or the data source's manager.
    return kindOf(checker, at, (n) => CONNECTIONS.has(n) || n === 'Repository')
      ? { kind: 'autocommit' }
      : unknown;
  };

  // The queries a function sends on one client, in order, with whether each sits in an if-branch that leaves the function.
  const clientQueries = (
    fn: ts.Node,
    client: string,
  ): Array<{ at: number; sql: string | undefined; exits: boolean }> => {
    const queries: Array<{ at: number; sql: string | undefined; exits: boolean }> = [];
    walk(fn, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== 'query' ||
        node.expression.expression.getText() !== client
      ) {
        return;
      }
      let block: ts.Node = node;
      while (!ts.isBlock(block.parent)) block = block.parent;
      const branch = block.parent;
      const exits =
        ts.isIfStatement(branch.parent) &&
        branch.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s));
      queries.push({ at: node.getStart(), sql: node.arguments[0] && sqlText(node.arguments[0]), exits });
    });
    return queries;
  };

  // A hand-run transaction is locked when, after its last BEGIN before the write, the next query takes the workflow row
  // on the same client and nothing commits or rolls back on the way to the write but a branch that leaves.
  const handLocked = (write: ts.Node, client: ts.Expression): boolean => {
    let fn: ts.Node | undefined = write;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (!fn) return false;
    const before = clientQueries(fn, client.getText()).filter((q) => q.at < write.getStart());
    const begin = before.map((q) => q.sql?.trim().toUpperCase()).lastIndexOf('BEGIN');
    const [lock, ...between] = before.slice(begin + 1);
    return (
      begin >= 0 &&
      lock !== undefined &&
      LOCK_SQL.test(lock.sql ?? '') &&
      !between.some((q) => !q.exits && /^\s*(COMMIT|ROLLBACK|BEGIN|END)\b/i.test(q.sql ?? ''))
    );
  };

  // Every call of a manager-taking writer. One it cannot follow is refused, and so is one never called.
  const callsOf = (fn: ts.SignatureDeclaration, from: ts.Node): ts.CallExpression[] => {
    const refuse = (why: string): ts.CallExpression[] => {
      verdict.offenders.push(`${where(from)} — ${why}`);
      return [];
    };
    if (!(ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) || !fn.name) {
      return refuse('written through a function expression or unnamed function this cannot follow');
    }
    const symbol = checker.getSymbolAtLocation(fn.name);
    const name = fn.name.getText();
    if (!symbol) return refuse(`written through ${name}, which this cannot resolve`);
    if (ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent)) {
      for (const clause of fn.parent.heritageClauses ?? []) {
        for (const base of clause.types) {
          if (checker.getTypeAtLocation(base).getProperty(name)) {
            return refuse(
              `written through ${name}, also reachable through ${base.getText()}.${name}, which this cannot follow`,
            );
          }
        }
      }
    }
    const calls: ts.CallExpression[] = [];
    for (const file of app.files) {
      walk(file, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name || node === fn.name) return;
        if (
          ts.isImportSpecifier(node.parent) ||
          ts.isExportSpecifier(node.parent) ||
          ts.isImportClause(node.parent)
        )
          return;
        if (!(resolved(checker, node)?.declarations ?? []).includes(fn)) return;
        const callee =
          ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee)
          calls.push(callee.parent);
        else
          verdict.offenders.push(
            `${where(node)} ${name} — passed on without being called, so its callers cannot be checked`,
          );
      });
    }
    return calls.length > 0 ? calls : refuse(`written through ${name}, which nothing found calls`);
  };

  const settled = new Set<string>();
  const reach = (site: ts.Node, context: Context, table: string): void => {
    if (context.kind === 'parameter') {
      const key = `${context.fn.getSourceFile().fileName}:${context.fn.getStart()}#${context.index}#${table}`;
      if (settled.has(key)) return;
      settled.add(key);
      for (const call of callsOf(context.fn, site)) {
        const argument = call.arguments[context.index];
        reach(
          call,
          argument ? classify(argument) : { kind: 'unknown', why: 'a call that passes no manager' },
          table,
        );
      }
      return;
    }
    const locked =
      context.kind === 'transaction' &&
      (context.opener === 'pointer' ||
        (context.opener === 'row' && guarded.has(table) && table !== POINTERS));
    if (locked) return;
    const key = `${memberKey(site)}#${table}`;
    if (UNLOCKED[key]?.in === context.kind) {
      verdict.exempted.add(key);
      return;
    }
    const why =
      context.kind === 'unknown'
        ? context.why
        : context.kind === 'transaction' && context.opener === 'row' && !guarded.has(table)
          ? 'a write this cannot tie to a table, under the row lock rather than the pointer-move lock'
          : context.kind === 'transaction' && table === POINTERS
            ? 'a pointer move whose transaction does not open with lockWorkflowForPointerMove on its own manager'
            : context.kind === 'transaction'
              ? 'a transaction that does not open with the workflow-row lock on its own manager'
              : `an unlocked ${context.kind} write`;
    verdict.offenders.push(`${where(site)} ${table} — ${why}`);
  };

  // Where SQL handed to a call runs: the query's own receiver, or what a pass-through helper sends it on.
  const sqlContext = (node: ts.Node): Context => {
    const holder = ts.isArrayLiteralExpression(node.parent) ? node.parent : node;
    const call = holder.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((a) => a === holder)) {
      return { kind: 'unknown', why: 'SQL not handed straight to a query' };
    }
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'query' &&
      holder === node
    ) {
      const manager = call.expression.expression;
      if (ts.isIdentifier(manager) || kindOf(checker, manager, (n) => CONNECTIONS.has(n))) {
        const context = classify(manager);
        return context.kind === 'manual'
          ? handLocked(node, unwrap(manager))
            ? { kind: 'transaction', opener: 'row' }
            : context
          : context;
      }
    }
    const via = PASS_THROUGH[declarationKey(resolved(checker, call.expression)) ?? ''];
    if (via === 'first argument' && call.arguments[0] && call.arguments[0] !== holder)
      return classify(call.arguments[0]);
    if (via === 'autocommit') return { kind: 'autocommit' };
    return { kind: 'unknown', why: `SQL handed to ${call.expression.getText()}, which this cannot follow` };
  };

  for (const file of app.files) {
    walk(file, (node) => {
      const isPart =
        node.parent !== undefined &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
      const text = isPart ? undefined : sqlText(node);
      if (text !== undefined) {
        const locked = ROW_LOCK.test(text) ? [...text.matchAll(SQL_READ)].map((m) => m[2]!) : [];
        const tables = [...[...text.matchAll(SQL_WRITE)].map((m) => m[3]!), ...locked]
          .filter((t) => t.includes(INTERPOLATED) || guarded.has(t.toLowerCase()))
          .map((t) => (t.includes(INTERPOLATED) ? 'an interpolated table' : t.toLowerCase()));
        if (tables.length > 0) {
          const context = sqlContext(node);
          for (const table of tables) reach(node, context, table);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query' &&
        kindOf(checker, node.expression.expression, (n) => CONNECTIONS.has(n)) &&
        (!node.arguments[0] || sqlText(node.arguments[0]) === undefined) &&
        !(memberKey(node) in OPAQUE_READS) &&
        !PASS_THROUGH[memberKey(node)]
      ) {
        verdict.offenders.push(
          `${where(node)} — SQL this cannot read: ${node.arguments[0]?.getText() ?? 'none'}`,
        );
      }
      const orm = ormWrite(app, node, guarded);
      if (orm) reach(node, classify(orm.manager), orm.table);
    });
  }
  return verdict;
}

const guarded = tablesUnderWorkflow(readFileSync(SCHEMA, 'utf8'));
const verdicts = APPS.map(({ app, dir }) => judge(load(app, dir), guarded));

describe('vault: every write under a workflow locks the workflow row first (constitution #11)', () => {
  it('reads the tables a workflow delete reaches from the schema', () => {
    expect([...guarded].sort()).toEqual([
      'composer_thread_events',
      'composer_threads',
      'review_approvals',
      'review_comments',
      'review_test_results',
      'runtime_activation_store',
      'runtime_runs',
      'runtime_trigger_activations',
      'webhook_trigger_secrets',
      'workflow_branches',
      'workflow_env_pointers',
      'workflow_reviews',
      'workflow_version_tags',
      'workflow_versions',
    ]);
  });

  it('follows a table first reached through SET NULL on to its own cascade children, and counts a NO ACTION reference', () => {
    const fk = (child: string, parent: string, action: string): string =>
      `ALTER TABLE ONLY public.${child}\n    ADD CONSTRAINT ${child}_${parent}_fkey FOREIGN KEY (${parent}_id) REFERENCES public.${parent}(id)${action};\n`;
    const schema = [
      fk('versions', 'workflows', ' ON DELETE CASCADE'),
      fk('rules', 'versions', ' ON DELETE SET NULL'),
      fk('rules', 'workflows', ' ON DELETE CASCADE'),
      fk('checks', 'rules', ' ON DELETE CASCADE'),
      fk('audits', 'workflows', ''),
    ].join('\n');

    expect([...tablesUnderWorkflow(schema)].sort()).toEqual(['audits', 'checks', 'rules', 'versions']);
  });

  it('finds every write to them in a transaction that locks the workflow row first, or listed with why it need not', () => {
    expect(verdicts.flatMap((v) => v.offenders)).toEqual([]);
  });

  it('reads every transaction, so none can hide a write', () => {
    expect(verdicts.flatMap((v) => v.transactions)).toEqual([]);
  });

  it('finds no transaction opened by hand in the service', () => {
    expect(verdicts[0]!.byHand).toEqual([]);
  });

  it('lists no exemption that no longer names a write', () => {
    const used = new Set(verdicts.flatMap((v) => [...v.exempted]));

    expect(Object.keys(UNLOCKED).filter((key) => !used.has(key))).toEqual([]);
  });
});
