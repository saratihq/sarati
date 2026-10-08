import { lowestCommonAncestor } from './branch.service';

/** Versions and their parents (first parent, then the merge parent). */
const history = (edges: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(edges));

describe('the merge base', () => {
  it('is the fork point of two straight lines', () => {
    const parents = history({ m0: [], m1: ['m0'], m2: ['m1'], b1: ['m1'], b2: ['b1'] });
    expect(lowestCommonAncestor('b2', 'm2', parents)).toBe('m1');
  });

  it("is the target's head once the branch has taken the target's changes", () => {
    // lane forked at m1, main moved to m2, lane merged main in (u1 = lane head + m2).
    const parents = history({ m1: [], m2: ['m1'], b1: ['m1'], u1: ['b1', 'm2'] });
    expect(lowestCommonAncestor('u1', 'm2', parents)).toBe('m2');
  });

  it('is the last merge, not the old fork point, when a kept branch is merged a second time', () => {
    // lane merged into main at m2 (merge parent b1); lane carried on to b2, main to m3.
    const parents = history({ m0: [], b1: ['m0'], m1: ['m0'], m2: ['m1', 'b1'], m3: ['m2'], b2: ['b1'] });
    expect(lowestCommonAncestor('b2', 'm3', parents)).toBe('b1');
  });

  it('never picks an ancestor of another common ancestor, even when it is fewer hops from the target', () => {
    // main's merge parent reaches the old fork f0 in one hop; the real base f1 is three first-parent hops away.
    const parents = history({
      f0: [],
      f1: ['f0'],
      x1: ['f1'],
      x2: ['x1'],
      side: ['f0'],
      main: ['x2', 'side'],
      lane: ['f1'],
    });
    expect(lowestCommonAncestor('lane', 'main', parents)).toBe('f1');
  });

  it('settles a criss-cross on one of the lowest, deterministically', () => {
    // a and b each merged the other's first commit: both a1 and b1 are lowest common ancestors.
    const parents = history({ r: [], a1: ['r'], b1: ['r'], a2: ['a1', 'b1'], b2: ['b1', 'a1'] });
    const base = lowestCommonAncestor('a2', 'b2', parents);
    expect(['a1', 'b1']).toContain(base);
    expect(lowestCommonAncestor('a2', 'b2', parents)).toBe(base);
  });

  it('is nothing when the histories never meet', () => {
    expect(lowestCommonAncestor('a', 'b', history({ a: [], b: [] }))).toBeNull();
  });
});
