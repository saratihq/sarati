import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolve a bundled data file across runtimes (src, dist, cwd), returning the first that exists or
 * null so callers degrade instead of throwing an ENOENT into a request.
 */
export function dataFile(fromDir: string, filename: string): string | null {
  const roots = [
    resolve(fromDir, '..', '..', 'data'), // src|dist /generation -> repo|dist /data
    resolve(fromDir, '..', '..', '..', 'data'), // src/generation/agents -> repo/data
    resolve(fromDir, '..', 'data'), // dist/generation -> dist/data (asset-copied)
    resolve(process.cwd(), 'data'),
  ];
  for (const root of roots) {
    const candidate = resolve(root, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
