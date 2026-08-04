/**
 * Open-core boundary enforcement (PRD §5.1 / E18):
 * OSS core must never import from ee/ — the dependency direction is one-way
 * (ee -> core seams). This rule is the thing that keeps the boundary honest.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-must-not-import-ee',
      severity: 'error',
      comment: 'OSS core cannot depend on commercial modules (PRD E18).',
      from: { path: '^src', pathNot: '^src/ee' },
      to: { path: '^src/ee' },
    },
    {
      name: 'moat-ir-is-pure',
      severity: 'error',
      comment:
        'The IR (diff/merge canon) is the moat core — it depends on nothing but ' +
        'itself and common. Peripheral concerns never leak in (src/domain/README.md).',
      from: { path: '^src/ir', pathNot: '\\.spec\\.ts$' },
      to: { path: '^src', pathNot: '^src/(ir|common)' },
    },
    {
      name: 'moat-compiler-bounded',
      severity: 'error',
      comment:
        'The compiler lowers IR to RunPlans — it may see ir/runtime/common and ' +
        'nothing else (src/domain/README.md).',
      from: { path: '^src/compiler', pathNot: '\\.spec\\.ts$' },
      to: { path: '^src', pathNot: '^src/(compiler|ir|runtime|common)' },
    },
    {
      name: 'moat-mcp-answers-nothing-itself',
      severity: 'error',
      comment:
        'The MCP surface is a thin caller onto services that already enforce the invariants ' +
        '(ADR 0052). It may name IR types, but it never compares, merges or compiles a ' +
        'document — that would be a second content oracle.',
      from: { path: '^src/mcp', pathNot: '\\.spec\\.ts$' },
      to: { path: '^src/(ir/(diff|merge)|compiler)' },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'A module nothing imports and that imports nothing is dead weight — delete it ' +
        'or wire it in. Exempt: the Nest bootstrap entry (main.ts), tests (*.spec), ' +
        'migrations, standalone scripts, and type-only declarations (*.d.ts).',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)main\\.ts$', // Nest bootstrap entry point
          '\\.spec\\.ts$', // unit tests reference their subject, but guard anyway
          '\\.d\\.ts$', // ambient/type-only declarations
          '(^|/)(migrations?|scripts)/', // one-shot migration + script entry points
        ],
      },
      to: {},
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'TypeORM bidirectional relations are deliberately circular (deferred via ' +
        'closure refs) — entities are exempt; everything else must stay acyclic.',
      from: { pathNot: '^src/database/entities' },
      to: { circular: true, pathNot: '^src/database/entities' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Count `import type` edges: many modules here are pure type carriers
    // (run-plan/dag-plan/review-test.types) reached only via type-only imports.
    // Without this the cruiser sees them as orphans and mis-scopes the moat rules.
    tsPreCompilationDeps: true,
  },
};
