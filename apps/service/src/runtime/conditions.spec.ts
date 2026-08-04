import { evaluateCondition } from './conditions';

describe('evaluateCondition', () => {
  const scope = {
    fetch: { body: { id: 42, name: 'widget', tags: ['a', 'b'], done: false, items: [1, 2, 3] } },
  };

  it('resolves {{ref}} operands and compares with eq/ne', () => {
    expect(evaluateCondition({ left: '{{fetch.body.id}}', op: 'eq', right: 42 }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{fetch.body.id}}', op: 'eq', right: 7 }, scope)).toBe(false);
    expect(evaluateCondition({ left: '{{fetch.body.name}}', op: 'ne', right: 'gadget' }, scope)).toBe(true);
  });

  it('does numeric ordering (operands coerced to number)', () => {
    expect(evaluateCondition({ left: '{{fetch.body.id}}', op: 'gt', right: 40 }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{fetch.body.id}}', op: 'lte', right: 42 }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{fetch.body.id}}', op: 'lt', right: 40 }, scope)).toBe(false);
  });

  it('truthy/falsy treat empty string/array/object as false', () => {
    expect(evaluateCondition({ left: '{{fetch.body.name}}', op: 'truthy' }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{fetch.body.done}}', op: 'falsy' }, scope)).toBe(true);
    expect(evaluateCondition({ left: '', op: 'truthy' }, scope)).toBe(false);
    expect(evaluateCondition({ left: [], op: 'truthy' }, scope)).toBe(false);
    expect(evaluateCondition({ left: '{{fetch.body.items}}', op: 'truthy' }, scope)).toBe(true);
  });

  it('contains works for strings and arrays', () => {
    expect(evaluateCondition({ left: '{{fetch.body.name}}', op: 'contains', right: 'idg' }, scope)).toBe(
      true,
    );
    expect(evaluateCondition({ left: '{{fetch.body.tags}}', op: 'contains', right: 'b' }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{fetch.body.tags}}', op: 'contains', right: 'z' }, scope)).toBe(false);
  });

  it('eq compares objects/arrays structurally', () => {
    expect(evaluateCondition({ left: '{{fetch.body.tags}}', op: 'eq', right: ['a', 'b'] }, scope)).toBe(true);
  });
});
