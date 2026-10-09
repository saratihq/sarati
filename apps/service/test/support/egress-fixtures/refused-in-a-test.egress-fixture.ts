import { dialOutside } from './dial';

it('swallows a refused dial', dialOutside);

it('dials nothing', () => undefined);
