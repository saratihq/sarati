import { ClaimResender } from './claim-resender';
import { RESEND_AFTER_SECONDS } from './run-waits';
import type { RunsService } from './runs.service';

describe('ClaimResender', () => {
  afterEach(() => jest.useRealTimers());

  it('sends every claim again at boot, then those left over on a timer of its own', async () => {
    jest.useFakeTimers();
    const resendClaims = jest.fn<Promise<number>, [number]>().mockResolvedValue(0);
    const resender = new ClaimResender({ resendClaims } as unknown as RunsService);

    await resender.onApplicationBootstrap();
    expect(resendClaims.mock.calls).toEqual([[0]]);

    await jest.advanceTimersByTimeAsync(RESEND_AFTER_SECONDS * 1000);
    await jest.advanceTimersByTimeAsync(RESEND_AFTER_SECONDS * 1000);
    expect(resendClaims.mock.calls).toEqual([[0], [RESEND_AFTER_SECONDS], [RESEND_AFTER_SECONDS]]);

    resender.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(RESEND_AFTER_SECONDS * 1000);
    expect(resendClaims).toHaveBeenCalledTimes(3);
  });

  it('never fails its caller when a resend throws', async () => {
    const resender = new ClaimResender({
      resendClaims: () => Promise.reject(new Error('db down')),
    } as unknown as RunsService);
    await expect(resender.retry()).resolves.toBeUndefined();
  });
});
