import { uniquelyNamed } from './unique-tool-names';

describe('uniquelyNamed', () => {
  it('offers every tool when no two share a name', () => {
    const tools = [{ name: 'a' }, { name: 'b' }];
    expect(uniquelyNamed(tools)).toEqual({ offered: tools, clashes: [] });
  });

  it('leaves out every tool that shares a name, and only those', () => {
    const tools = [
      { name: 'digest', id: 1 },
      { name: 'send', id: 2 },
      { name: 'digest', id: 3 },
    ];
    expect(uniquelyNamed(tools)).toEqual({ offered: [{ name: 'send', id: 2 }], clashes: ['digest'] });
  });
});
