import { contractOf, inputsOf, schemaOf, toolNameOf } from './workflow-tool-contract';

describe('what a workflow declares about being called as a tool', () => {
  it('withholds a tool that declares no description — a model picks on description alone', () => {
    expect(contractOf({ tool_name: 'doubler', inputs: [] }, 'Doubler')).toBeNull();
    expect(contractOf({ tool_name: 'doubler', description: '   ' }, 'Doubler')).toBeNull();
  });

  it('falls back to the workflow name when no tool_name is declared', () => {
    expect(contractOf({ description: 'Doubles a number.' }, 'My Doubler')?.name).toBe('my_doubler');
  });

  it('refuses a name that would shadow a platform tool rather than renaming it silently', () => {
    expect(toolNameOf('orchestr_get_workflow', 'fallback')).toBeNull();
    expect(contractOf({ tool_name: 'orchestr_diff', description: 'x' }, 'w')).toBeNull();
  });

  it('drops a malformed argument rather than publishing a broken schema', () => {
    const inputs = inputsOf([{ name: 'n', type: 'number' }, { type: 'string' }, { name: '  ' }]);
    expect(inputs).toEqual([{ name: 'n', type: 'number', description: '', required: false }]);
  });

  it('accepts declared inputs sent as a JSON string, as the editor stores them', () => {
    expect(inputsOf('[{"name":"n","type":"number","required":true}]')).toEqual([
      { name: 'n', type: 'number', description: '', required: true },
    ]);
    expect(inputsOf('not json')).toEqual([]);
  });

  it('falls back to string for an unknown declared type', () => {
    expect(inputsOf([{ name: 'x', type: 'date' }])).toEqual([
      { name: 'x', type: 'string', description: '', required: false },
    ]);
  });

  it('renders the declared inputs as the JSON schema a model is handed', () => {
    const schema = schemaOf([
      { name: 'n', type: 'number', description: 'The number to double', required: true },
      { name: 'note', type: 'string', description: '', required: false },
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        n: { type: 'number', description: 'The number to double' },
        note: { type: 'string' },
      },
      required: ['n'],
      additionalProperties: true,
    });
  });
});
