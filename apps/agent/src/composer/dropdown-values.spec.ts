import { resolveDropdownParams, type DropdownOption } from './dropdown-values';

const CHANNELS: DropdownOption[] = [
  { label: '#new-channel', value: 'C0BFH3LPHV3' },
  { label: '#social', value: 'C0BFN9NKRUH' },
  { label: '#all-orchestr', value: 'C0BGEMVTR3J' },
];

const liveSchema = { channel: { type: 'DROPDOWN' }, text: { type: 'LONG_TEXT' } };
const loader = (options: DropdownOption[] | null) => () => Promise.resolve(options);

describe('resolveDropdownParams', () => {
  it('rewrites a live dropdown LABEL to the option value the step runs on', async () => {
    const { parameters, notes } = await resolveDropdownParams(
      liveSchema,
      { channel: '#social', text: 'hi' },
      loader(CHANNELS),
    );
    expect(parameters).toEqual({ channel: 'C0BFN9NKRUH', text: 'hi' });
    expect(notes.join(' ')).toContain('#social');
  });

  it('matches a label the person wrote without its "#"', async () => {
    const { parameters } = await resolveDropdownParams(liveSchema, { channel: 'Social' }, loader(CHANNELS));
    expect(parameters.channel).toBe('C0BFN9NKRUH');
  });

  it('leaves a value that is already an option value untouched', async () => {
    const { parameters, notes } = await resolveDropdownParams(
      liveSchema,
      { channel: 'C0BFH3LPHV3' },
      loader(CHANNELS),
    );
    expect(parameters.channel).toBe('C0BFH3LPHV3');
    expect(notes).toEqual([]);
  });

  it('resolves a STATIC_DROPDOWN from the schema without loading anything', async () => {
    const schema = {
      types: {
        type: 'STATIC_DROPDOWN',
        options: [
          { label: 'Public channels', value: 'public_channel' },
          { label: 'Public and private', value: 'public_channel,private_channel' },
        ],
      },
    };
    const load = jest.fn();
    const { parameters } = await resolveDropdownParams(
      schema,
      { types: 'Public and private' },
      load as never,
    );
    expect(parameters.types).toBe('public_channel,private_channel');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps a {{ref}} and a value it cannot load options for, and says so only when it can', async () => {
    const ref = await resolveDropdownParams(liveSchema, { channel: '{{trigger.channel}}' }, loader(CHANNELS));
    expect(ref.parameters.channel).toBe('{{trigger.channel}}');
    expect(ref.notes).toEqual([]);

    const unloadable = await resolveDropdownParams(liveSchema, { channel: '#social' }, loader(null));
    expect(unloadable.parameters.channel).toBe('#social');
    expect(unloadable.notes).toEqual([]);
  });

  it('reports a value that matches no option instead of inventing one', async () => {
    const { parameters, notes } = await resolveDropdownParams(
      liveSchema,
      { channel: '#nowhere' },
      loader(CHANNELS),
    );
    expect(parameters.channel).toBe('#nowhere');
    expect(notes[0]).toContain('not one of the options');
    expect(notes[0]).toContain('#social');
  });
});
