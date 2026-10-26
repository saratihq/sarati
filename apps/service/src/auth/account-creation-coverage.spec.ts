import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

/** The only files that may create a user row — each admits the account by its own reviewed rule. */
const CREATION_SITES = [
  // Password registration and single sign-on, under the one advisory-locked admission.
  'auth/local/admission.service.ts',
  // Clerk's managed sign-up, and the fixed MOCK_AUTH user (refused in production).
  'auth/user-provisioning.service.ts',
];

const CREATES_A_USER = [
  /\bcreate\(\s*UserEntity\b/,
  /\binsert\(\s*UserEntity\b/,
  /\bsave\(\s*UserEntity\b/,
  /INSERT\s+INTO\s+(public\.)?users\b/i,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** An account born outside the admission seam skips its rules, so a new creation site has to be added here on purpose. */
describe('account creation coverage', () => {
  const creating = sourceFiles(SRC_ROOT)
    .filter((file) => CREATES_A_USER.some((pattern) => pattern.test(readFileSync(file, 'utf8'))))
    .map((file) => relative(SRC_ROOT, file))
    .sort();

  it('finds the creation sites it guards', () => {
    expect(creating.length).toBeGreaterThan(0);
  });

  it('creates users only in the reviewed files', () => {
    expect(creating).toEqual([...CREATION_SITES].sort());
  });
});
