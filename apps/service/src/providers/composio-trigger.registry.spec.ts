import { composioTriggerSpec, composioTriggerTypes } from './composio-trigger.registry';

/** The gmail Composio-poll spec, pure: query building mirrors Gmail's search grammar, extraction the live tool shape. */
describe('composio-trigger.registry — gmail.gmail_new_email_received', () => {
  const spec = composioTriggerSpec('gmail.gmail_new_email_received')!;

  it('registers gmail (and only expected types)', () => {
    expect(spec).toBeDefined();
    expect(spec.toolSlug).toBe('GMAIL_FETCH_EMAILS');
    expect(composioTriggerSpec('rss.new-item')).toBeUndefined();
    expect([...composioTriggerTypes()]).toEqual(['gmail.gmail_new_email_received']);
  });

  it('builds the Gmail query grammar from the trigger props + cursor', () => {
    const cursor = 1_780_000_000_123; // ms — after: floors to seconds
    const args = spec.buildArguments(
      {
        from: 'boss@corp.com',
        to: 'me@corp.com',
        subject: 'invoice',
        label: { name: 'Work' }, // the dropdown value is an object
        category: 'primary',
      },
      cursor,
    );
    expect(args).toEqual({
      query:
        'from:(boss@corp.com) to:(me@corp.com) subject:(invoice) label:Work category:primary after:1780000000',
      max_results: 20,
    });
  });

  it('accepts a bare-string label and skips empty props', () => {
    const args = spec.buildArguments({ subject: 'x', label: 'Inbox', from: '' }, 1_000_000);
    expect(args.query).toBe('subject:(x) label:Inbox after:1000');
  });

  it('a cursor-less poll has no after: and samples a small window', () => {
    expect(spec.buildArguments({}, 0)).toEqual({ max_results: 5 }); // no empty query key
    expect(spec.buildArguments({ subject: 'x' }, 0)).toEqual({
      query: 'subject:(x)',
      max_results: 5,
    });
  });

  it('extracts items oldest-first regardless of fetch order (Composio scrambles it)', () => {
    const items = spec.extractItems({
      messages: [
        { messageId: 'b', messageTimestamp: '2026-07-12T15:35:20Z' },
        { messageId: 'c', messageTimestamp: '2026-07-12T14:50:06Z' },
        { messageId: 'a', messageTimestamp: '2026-07-12T15:10:21Z' },
      ],
    });
    expect(items.map((i) => (i.payload as { messageId: string }).messageId)).toEqual(['c', 'a', 'b']);
    expect(items[0]!.epochMilliSeconds).toBe(Date.parse('2026-07-12T14:50:06Z'));
  });

  it('falls back to a raw internalDate epoch and skips unparseable messages', () => {
    const items = spec.extractItems({
      messages: [
        { messageId: 'raw', internalDate: '1780000000000' },
        { messageId: 'broken', messageTimestamp: 'not-a-date' },
        { messageId: 'empty' },
        'not-an-object',
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.epochMilliSeconds).toBe(1_780_000_000_000);
  });

  it('degrades an unexpected envelope to no items (never throws)', () => {
    expect(spec.extractItems(null)).toEqual([]);
    expect(spec.extractItems({})).toEqual([]);
    expect(spec.extractItems({ messages: 'nope' })).toEqual([]);
  });
});
