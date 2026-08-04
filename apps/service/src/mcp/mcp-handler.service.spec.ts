import type { ApiScope } from '../auth/scopes';
import type { ApiKeyPrincipal, UserPrincipal } from '../auth/principal';
import { McpHandlerService } from './mcp-handler.service';
import type { McpTool } from './mcp-tool';

const tool = (name: string, scope: ApiScope): McpTool => ({ name, scope }) as unknown as McpTool;

const TOOLS = [
  tool('orchestr_get_workflow', 'workflow:read'),
  tool('orchestr_commit', 'workflow:write'),
  tool('orchestr_context', 'workflow:read'),
  tool('orchestr_list_connections', 'connection:read'),
];

const key = (scopes: string[] | null): ApiKeyPrincipal =>
  ({ kind: 'api_key', scopes, keyOrgId: 'org', user: { id: 'u' } }) as unknown as ApiKeyPrincipal;

const session = (): UserPrincipal => ({ kind: 'user', user: { id: 'u' } }) as unknown as UserPrincipal;

describe('McpHandlerService tool filtering', () => {
  // The tenant-tool collaborators are never reached: this spec exercises scope filtering only.
  const handler = new McpHandlerService(TOOLS, undefined as never, undefined as never);

  afterAll(async () => {
    await handler.onModuleDestroy();
  });

  it('lists tools in a deterministic order regardless of registration order', () => {
    expect(handler.ordered().map((t) => t.name)).toEqual([
      'orchestr_commit',
      'orchestr_context',
      'orchestr_get_workflow',
      'orchestr_list_connections',
    ]);
  });

  it('gives a scoped key only the tools its scopes satisfy', () => {
    expect(handler.toolsFor(key(['workflow:read'])).map((t) => t.name)).toEqual([
      'orchestr_context',
      'orchestr_get_workflow',
    ]);
  });

  it('gives a session every tool — a signed-in human carries full authority', () => {
    expect(handler.toolsFor(session())).toHaveLength(TOOLS.length);
  });

  it('treats a legacy unscoped key as full authority (scopes: null)', () => {
    expect(handler.toolsFor(key(null))).toHaveLength(TOOLS.length);
  });

  it('never hands an authenticated caller an empty surface by accident', () => {
    expect(handler.toolsFor(key(['connection:read'])).map((t) => t.name)).toEqual([
      'orchestr_list_connections',
    ]);
  });
});
