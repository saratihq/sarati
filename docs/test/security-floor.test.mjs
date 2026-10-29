import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const prose = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const floor = /^SAFE_VERSION=(\S+)$/m.exec(readFileSync(new URL('../../install.sh', import.meta.url), 'utf8'))?.[1];

test('the README and the upgrades page name the version the installer warns below', () => {
  assert.ok(floor, 'install.sh sets SAFE_VERSION');
  assert.ok(prose('../../README.md').includes(`**Run ${floor} or later.**`), `README.md says to run ${floor} or later`);
  assert.ok(
    prose('../src/content/docs/operate/upgrades.md').includes(`Pin ${floor} or later`),
    `upgrades.md says to pin ${floor} or later`,
  );
});
