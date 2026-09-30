import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_DIR = join(__dirname, 'tools');
const DOCS_PAGE = join(__dirname, '../../../../docs/src/content/docs/agents/mcp.md');

/** The MCP page tells an operator what a key can do, so it is held to the tools that actually exist. */
describe('docs/agents/mcp.md', () => {
  const page = readFileSync(DOCS_PAGE, 'utf8');
  const tools = readdirSync(TOOLS_DIR)
    .filter((file) => file.endsWith('.tool.ts'))
    .map((file) => {
      const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
      return {
        file,
        name: /readonly name = '([a-z_]+)'/.exec(source)?.[1],
        scope: /readonly scope: ApiScope = '([a-z:]+)'/.exec(source)?.[1],
      };
    });

  it('reads a name and a scope out of every tool file', () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((tool) => !tool.name || !tool.scope).map((tool) => tool.file)).toEqual([]);
  });

  it('lists every tool on the row of the scope that grants it', () => {
    const rows = page.split('\n');
    const undocumented = tools
      .filter(({ name, scope }) => {
        const row = rows.find((line) => line.startsWith(`| \`${scope}\` |`));
        return !row?.includes(`\`${name}\``);
      })
      .map(({ name, scope }) => `${name} (${scope})`);
    expect(undocumented).toEqual([]);
  });

  it('names no tool that does not exist', () => {
    const real = new Set(tools.map((tool) => tool.name));
    const documented = [...new Set(page.match(/orchestr_[a-z_]+/g) ?? [])];
    expect(documented.filter((name) => !real.has(name))).toEqual([]);
  });
});
