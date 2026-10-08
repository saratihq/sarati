import { accountRefFields, accountRefText, fillAccountRefs } from './account-ref';
import { resolveReferences } from './reference-resolver';

describe('{{$account…}}', () => {
  it('finds every account reference, nested or embedded, and the field each reads', () => {
    expect(
      accountRefFields({
        to: '{{$account.email}}',
        nested: [{ text: 'Hi {{ $account.name }}, from {{step.out}}' }],
        bare: '{{$account}}',
        other: '{{$accounts.email}} {{$auth.token}}',
      }),
    ).toEqual(['email', 'name', '']);
  });

  it('fills each with the account value, leaving everything else as it was', () => {
    const filled = fillAccountRefs(
      { to: '{{$account.email}}', note: 'Hi {{ $account.name }}, see {{step.out}}', count: 3 },
      (field) => ({ email: 'me@e2e.local', name: 'Me' })[field] ?? 'unknown',
    );
    expect(filled).toEqual({ to: 'me@e2e.local', note: 'Hi Me, see {{step.out}}', count: 3 });
  });

  it('passes the interpreter untouched, so only the router can fill it', () => {
    expect(resolveReferences({ to: '{{$account.email}}', cc: 'x {{$account.email}}' }, {})).toEqual({
      to: '{{$account.email}}',
      cc: 'x {{$account.email}}',
    });
  });

  it('reads back in messages the way it is written', () => {
    expect(accountRefText('email')).toBe('{{$account.email}}');
    expect(accountRefText('')).toBe('{{$account}}');
  });
});
