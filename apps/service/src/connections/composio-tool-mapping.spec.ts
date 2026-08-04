import { matchTool, tokenize, translateProps, type ComposioToolShape } from './composio-tool-mapping';

const tool = (slug: string, name: string, inputProperties: string[] = []): ComposioToolShape => ({
  slug,
  name,
  inputProperties,
});

// Real catalog slugs, so the matcher is exercised against the actual naming it must survive.
const SLACK_TOOLS = [
  tool('SLACK_LIST_ALL_USERS', 'List all users'),
  tool('SLACK_LIST_WORKSPACE_USERS', 'List workspace users'),
  tool('SLACK_LIST_ALL_SLACK_TEAM_USERS_WITH_PAGINATION', 'List all team users', ['limit', 'cursor']),
  tool('SLACK_FIND_USERS', 'Find users', ['search_query']),
  tool('SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'Send message to a channel', [
    'channel',
    'text',
    'thread_ts',
    'as_user',
  ]),
  tool('SLACK_CREATE_CHANNEL', 'Create channel'),
];

const TRELLO_TOOLS = [
  tool('TRELLO_GET_CARDS_BY_ID_CARD', 'Get a card by id', ['idCard', 'fields']),
  tool('TRELLO_BOARD_GET_CARDS_BY_ID_BOARD', 'Get cards on a board', ['idBoard']),
  tool('TRELLO_DELETE_CARDS_BY_ID_CARD', 'Delete a card by id', ['idCard']),
];

describe('tokenize', () => {
  it('splits camelCase and singularises', () => {
    expect(tokenize('listUsers')).toEqual(['list', 'user']);
  });

  it('splits snake_case and drops filler tokens', () => {
    expect(tokenize('get_card')).toEqual(['get', 'card']);
    expect(tokenize('SLACK_LIST_ALL_USERS')).toEqual(['slack', 'list', 'all', 'user']);
  });
});

describe('matchTool', () => {
  it('resolves a read action to the cleanest matching tool', () => {
    // Both LIST_ALL_USERS and LIST_WORKSPACE_USERS cover {list,user} with equal
    // precision; the deterministic tie-break (shorter slug) picks ALL_USERS.
    expect(matchTool('listUsers', 'slack', SLACK_TOOLS)?.slug).toBe('SLACK_LIST_ALL_USERS');
  });

  it('picks the single-object tool over the higher-noise sibling (precision tie-break)', () => {
    // get_card must resolve to the by-card tool, NOT the by-board list of cards.
    expect(matchTool('get_card', 'trello', TRELLO_TOOLS)?.slug).toBe('TRELLO_GET_CARDS_BY_ID_CARD');
  });

  it('maps send_channel_message to the full send tool and carries its arg names', () => {
    const match = matchTool('send_channel_message', 'slack', SLACK_TOOLS);
    expect(match?.slug).toBe('SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL');
    expect(match?.inputProperties).toContain('thread_ts');
  });

  it('refuses a cross-verb match (delete must never resolve to a get tool)', () => {
    // Only get/board-get tools present → a delete action finds its own verb class.
    expect(matchTool('delete_card', 'trello', TRELLO_TOOLS)?.slug).toBe('TRELLO_DELETE_CARDS_BY_ID_CARD');
    // With ONLY the get tool available, delete_card has no valid match.
    expect(matchTool('delete_card', 'trello', [TRELLO_TOOLS[0]!])).toBeNull();
  });

  it('returns null when no tool shares the action nouns (app stays non-fallback-able)', () => {
    expect(matchTool('teleport_widget', 'slack', SLACK_TOOLS)).toBeNull();
  });
});

describe('translateProps', () => {
  it('re-keys camelCase props to snake_case tool arguments', () => {
    const { arguments: args, dropped } = translateProps(
      { channel: 'C123', text: 'hi', threadTs: '1710304378.475129' },
      ['channel', 'text', 'thread_ts', 'as_user'],
    );
    expect(args).toEqual({ channel: 'C123', text: 'hi', thread_ts: '1710304378.475129' });
    expect(dropped).toEqual([]);
  });

  it('drops (and reports) props the tool has no argument for', () => {
    const { arguments: args, dropped } = translateProps({ channel: 'C123', sendAsBot: true }, [
      'channel',
      'text',
      'as_user',
    ]);
    expect(args).toEqual({ channel: 'C123' });
    expect(dropped).toEqual(['sendAsBot']); // semantic mismatch: our sendAsBot ≠ tool as_user
  });

  it('skips null/undefined props but keeps false/0', () => {
    const { arguments: args } = translateProps({ a: false, b: 0, c: undefined, d: null }, [
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(args).toEqual({ a: false, b: 0 });
  });

  it('matches an EXACT arg name over a colliding normalized key (required arg not displaced)', () => {
    // A real tool declares REQUIRED `team_Id` alongside optional `team_id`, both collapsing to `teamid`:
    // without exact-match-first the supplied value re-keys onto the wrong arg and the provider reports it missing.
    const { arguments: args, dropped } = translateProps({ team_Id: 42, start: 1, duration: 5 }, [
      'end',
      'start',
      'team_Id',
      'team_id',
      'duration',
    ]);
    expect(args.team_Id).toBe(42); // the REQUIRED arg keeps the value
    expect(args.team_id).toBeUndefined(); // the optional collision sibling stays empty
    expect(dropped).toEqual([]);
  });

  it('prefers the first-declared arg on a normalized collision when no exact match exists', () => {
    // A variant spelling hits the normalized bridge; first-write-wins keeps it on the canonical arg.
    const { arguments: args } = translateProps({ teamId: 7 }, ['team_Id', 'team_id']);
    expect(args.team_Id).toBe(7);
    expect(args.team_id).toBeUndefined();
  });

  describe('P0.4c: heals a JSON-encoded array/object string to its declared container type', () => {
    it('parses a JSON array string into an array', () => {
      const { arguments: args, coercionSkipped } = translateProps({ cc: '["a@x.com","b@y.com"]' }, ['cc'], {
        cc: 'array',
      });
      expect(args.cc).toEqual(['a@x.com', 'b@y.com']);
      expect(coercionSkipped).toEqual([]);
    });

    it('parses a JSON object string into an object', () => {
      const { arguments: args, coercionSkipped } = translateProps({ meta: '{"k":1,"v":true}' }, ['meta'], {
        meta: 'object',
      });
      expect(args.meta).toEqual({ k: 1, v: true });
      expect(coercionSkipped).toEqual([]);
    });

    it('leaves a non-JSON string for an array param untouched and flags the skip', () => {
      const { arguments: args, coercionSkipped } = translateProps({ cc: 'a@x.com' }, ['cc'], { cc: 'array' });
      expect(args.cc).toBe('a@x.com'); // unambiguous-only: the tool surfaces the real error
      expect(coercionSkipped).toEqual(['cc']);
    });

    it('leaves a wrong-shape JSON (object where an array is declared) untouched and flags it', () => {
      const { arguments: args, coercionSkipped } = translateProps({ cc: '{"a":1}' }, ['cc'], { cc: 'array' });
      expect(args.cc).toBe('{"a":1}');
      expect(coercionSkipped).toEqual(['cc']);
    });

    it('leaves a JSON array where an object is declared untouched', () => {
      const { arguments: args, coercionSkipped } = translateProps({ meta: '[1,2]' }, ['meta'], {
        meta: 'object',
      });
      expect(args.meta).toBe('[1,2]');
      expect(coercionSkipped).toEqual(['meta']);
    });

    it('leaves an already-array value untouched (no skip flagged)', () => {
      const { arguments: args, coercionSkipped } = translateProps({ cc: ['a@x.com'] }, ['cc'], {
        cc: 'array',
      });
      expect(args.cc).toEqual(['a@x.com']);
      expect(coercionSkipped).toEqual([]);
    });
  });

  describe('P0.4b: coerces to the declared JSON-schema type when safely coercible', () => {
    it('turns a clean integer/number string into a number', () => {
      const { arguments: args } = translateProps({ pageSize: '42', ratio: '3.5' }, ['pageSize', 'ratio'], {
        pageSize: 'integer',
        ratio: 'number',
      });
      expect(args).toEqual({ pageSize: 42, ratio: 3.5 });
    });

    it('turns canonical boolean strings into real booleans', () => {
      const { arguments: args } = translateProps(
        { a: 'true', b: 'false', c: '1', d: 'no' },
        ['a', 'b', 'c', 'd'],
        {
          a: 'boolean',
          b: 'boolean',
          c: 'boolean',
          d: 'boolean',
        },
      );
      expect(args).toEqual({ a: true, b: false, c: true, d: false });
    });

    it('leaves a non-numeric string for an integer param untouched (the tool surfaces the error)', () => {
      const { arguments: args } = translateProps({ pageSize: 'lots', frac: '4.2' }, ['pageSize', 'frac'], {
        pageSize: 'integer',
        frac: 'integer',
      });
      expect(args).toEqual({ pageSize: 'lots', frac: '4.2' }); // '4.2' is not a clean integer
    });

    it('leaves values already of the correct type (and untyped/other params) untouched', () => {
      const { arguments: args } = translateProps(
        { pageSize: 100, enabled: true, name: 'ada', note: 'true' },
        ['pageSize', 'enabled', 'name', 'note'],
        { pageSize: 'integer', enabled: 'boolean', name: 'string' }, // note has no declared type
      );
      expect(args).toEqual({ pageSize: 100, enabled: true, name: 'ada', note: 'true' });
    });
  });
});
