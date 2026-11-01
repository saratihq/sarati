import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { ShutdownDeadline } from './common/shutdown-deadline';
import { JobRegistry } from './jobs/jobs.module';

/** The root module's hooks, which Nest runs after every other module's at a boot and before them at a stop. */
@Injectable()
export class AppLifecycle implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private closeHttp: NodeJS.Timeout | undefined;

  constructor(
    private readonly jobs: JobRegistry,
    private readonly deadline: ShutdownDeadline,
    private readonly http: HttpAdapterHost,
  ) {}

  /** Attaches the job workers only once the rest of the boot, DBOS's launch included, has succeeded. */
  onApplicationBootstrap(): Promise<void> {
    const server = this.server();
    server?.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
      if (this.deadline.signal.aborted) res.shouldKeepAlive = false;
      // Node leaves a connection open once its response ends, even while its server closes, until the client drops it.
      res.once('close', () => {
        if (this.deadline.signal.aborted && !server.listening) server.closeIdleConnections();
      });
    });
    return this.jobs.start();
  }

  /** Begins the stop's deadline; once it is up, the HTTP server takes no connection and drops every one still open. */
  onModuleDestroy(): void {
    const ms = this.deadline.remainingMs();
    const server = this.server();
    if (!server) return;
    this.closeHttp = setTimeout(() => {
      server.close();
      server.closeAllConnections();
    }, ms);
    this.closeHttp.unref();
  }

  onApplicationShutdown(): void {
    clearTimeout(this.closeHttp);
  }

  private server(): Server | undefined {
    return this.http.httpAdapter?.getHttpServer() as Server | undefined;
  }
}
