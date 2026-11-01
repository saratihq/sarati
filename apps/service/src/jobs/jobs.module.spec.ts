import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ShutdownDeadline } from '../common/shutdown-deadline';
import { JobRegistry, JobSender, JobsLifecycle, JobsModule, PG_BOSS } from './jobs.module';

@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => ({ pgBossEnabled: false }) } },
    ShutdownDeadline,
  ],
  exports: [ConfigService, ShutdownDeadline],
})
class Host {}

@Injectable()
class ReachesForPgBoss {
  constructor(@Inject(PG_BOSS) readonly boss: unknown) {}
}

@Injectable()
class SendsAndWorks {
  constructor(
    readonly sender: JobSender,
    readonly registry: JobRegistry,
    readonly lifecycle: JobsLifecycle,
  ) {}
}

describe('JobsModule', () => {
  it('lets a module that imports it send jobs, register workers and stop pg-boss', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [Host, JobsModule],
      providers: [SendsAndWorks],
    }).compile();

    const { sender, registry, lifecycle } = moduleRef.get(SendsAndWorks);
    expect(sender).toBeInstanceOf(JobSender);
    expect(registry).toBeInstanceOf(JobRegistry);
    expect(lifecycle).toBeInstanceOf(JobsLifecycle);
    await expect(sender.send('queue', {})).resolves.toBe(false);
  });

  it('keeps pg-boss itself to itself, so no worker can attach but through the registry', async () => {
    await expect(
      Test.createTestingModule({ imports: [Host, JobsModule], providers: [ReachesForPgBoss] }).compile(),
    ).rejects.toThrow(/can't resolve dependencies of the ReachesForPgBoss \(\?\)/);
  });
});
