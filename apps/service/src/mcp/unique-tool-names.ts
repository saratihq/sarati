/** Tools whose names come out the same are left out together: one name must reach exactly one workflow. */
export function uniquelyNamed<T extends { name: string }>(tools: T[]): { offered: T[]; clashes: string[] } {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  const clashes = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  return { offered: tools.filter((tool) => counts.get(tool.name) === 1), clashes };
}
