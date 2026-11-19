import type { ComposioProvider } from '../../src/connections/composio.provider';

/** Composio, for a suite holding a fake key, listing `types` as app triggers on managed toolkits, so the picker and the author gate offer them. */
export function listComposioTriggers(composio: ComposioProvider, ...types: string[]): void {
  const listed = types.map((type) => {
    const dot = type.indexOf('.');
    const app = type.slice(0, dot);
    return {
      slug: type.slice(dot + 1).toUpperCase(),
      name: type,
      description: '',
      toolkitSlug: app,
      config: {},
      type: 'webhook',
    };
  });
  jest.spyOn(composio, 'listTriggerTypes').mockResolvedValue(listed);
  jest
    .spyOn(composio, 'listManagedToolkits')
    .mockResolvedValue([...new Set(listed.map((t) => t.toolkitSlug))].map((slug) => ({ slug, name: slug })));
}
