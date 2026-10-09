import { dialOutside } from './dial';

describe('a describe whose hooks reach out', () => {
  beforeAll(dialOutside);
  afterAll(dialOutside);
  it('dials nothing', () => undefined);
});

describe('the describe after it', () => {
  it('dials nothing either', () => undefined);
});
