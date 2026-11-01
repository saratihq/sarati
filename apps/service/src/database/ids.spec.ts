import { isIdShape, nameBasedId } from './ids';

describe('nameBasedId', () => {
  it('names the same parts with the same version-5 id, and any other parts or order with another', () => {
    const id = nameBasedId('activation', 'delivery');
    expect(nameBasedId('activation', 'delivery')).toBe(id);
    expect(isIdShape(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(
      new Set([
        id,
        nameBasedId('delivery', 'activation'),
        nameBasedId('activation', 'other'),
        nameBasedId('activationdelivery'),
      ]).size,
    ).toBe(4);
  });

  it('mints the ids it has always minted, since a resend finds its run by the id', () => {
    expect(nameBasedId('activation', 'delivery')).toBe('88221690-8ee6-5927-ab34-e8e93ebc113a');
    expect(nameBasedId('activation', 'epoch', 'delivery')).toBe('c2c5c862-2b39-5878-ace4-46e6d7541665');
  });
});
