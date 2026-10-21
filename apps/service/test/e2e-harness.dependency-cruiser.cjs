const e2eConfig = require('./jest-e2e.json');

// Setup files run inside each suite's realm; every other module the config names runs in jest's own.
const SUITE_REALM_KEYS = new Set(['setupFiles', 'setupFilesAfterEnv']);

function modulePaths(value) {
  if (typeof value === 'string') return /^<rootDir>\/(.+\.[cm]?[jt]s)$/.exec(value)?.slice(1) ?? [];
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(modulePaths) : [];
}

const parentRealmEntries = Object.entries(e2eConfig)
  .filter(([key]) => !SUITE_REALM_KEYS.has(key))
  .flatMap(([, value]) => modulePaths(value))
  .map((entry) => `^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

module.exports = {
  forbidden: [
    {
      name: 'e2e-harness-realm-loads-no-app',
      severity: 'error',
      comment:
        'Jest gives every suite the globals of its own realm, where the modules jest-e2e.json names run, so ' +
        'app code or a package they load that keeps state on the global (class-validator does) is shared by ' +
        'every suite and keeps each one in memory until the run ends.',
      from: { path: parentRealmEntries },
      to: {
        reachable: true,
        path: ['^src/', 'node_modules/'],
        pathNot: ['^src/config/default-database-url\\.ts$', 'node_modules/(pg|jest-environment-node)/'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Only what still loads once compiled: a type-only import puts nothing in jest's realm.
    tsPreCompilationDeps: false,
  },
};
