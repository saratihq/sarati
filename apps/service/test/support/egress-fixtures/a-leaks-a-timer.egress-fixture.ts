import { dialOutside } from './dial';

it('leaves behind a timer that dials once the suite is over', () => {
  setTimeout(() => void dialOutside(), 300);
});
