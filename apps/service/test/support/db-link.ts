import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

/** A query the link stopped on its way to Postgres. */
export interface HeldQuery {
  /** The backend process serving the held query's connection, for `pg_terminate_backend`. */
  pid: number;
  /** Sends it on, and everything its connection sent after it. */
  release(): void;
}

const BACKEND_KEY_DATA = 0x4b;

function backendPid(reply: Buffer): number | undefined {
  for (let at = 0; at + 5 <= reply.length;) {
    const end = at + 1 + reply.readInt32BE(at + 1);
    if (end > reply.length) return undefined;
    if (reply[at] === BACKEND_KEY_DATA) return reply.readInt32BE(at + 5);
    at = end;
  }
  return undefined;
}

function simpleQueryMessage(sql: string): Buffer {
  const text = Buffer.from(`${sql}\0`);
  const length = Buffer.alloc(4);
  length.writeInt32BE(4 + text.length);
  return Buffer.concat([Buffer.from('Q'), length, text]);
}

/** A loopback TCP link to a database, which can hold the next query of a given text on whichever connection sends it. */
export class DbLink {
  private armed?: { message: Buffer; found: (held: HeldQuery) => void };
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((client) => this.carry(client));

  private constructor(private readonly target: URL) {}

  /** A link to `databaseUrl`, listening on loopback. */
  static async open(databaseUrl: string): Promise<DbLink> {
    const link = new DbLink(new URL(databaseUrl));
    await new Promise<void>((resolve) => link.server.listen(0, '127.0.0.1', resolve));
    return link;
  }

  /** `databaseUrl`, reached through this link. */
  get url(): string {
    const through = new URL(this.target);
    through.host = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return through.toString();
  }

  /** Resolves once the next `sql` query sent through the link is held. */
  holdNext(sql: string): Promise<HeldQuery> {
    return new Promise((found) => (this.armed = { message: simpleQueryMessage(sql), found }));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private carry(client: Socket): void {
    const upstream = connect(Number(this.target.port || 5432), this.target.hostname);
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    }
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('end', () => upstream.end());
    upstream.pipe(client);

    let pid: number | undefined;
    let reply = Buffer.alloc(0);
    const learnPid = (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      pid = backendPid(reply);
      if (pid !== undefined) upstream.off('data', learnPid);
    };
    upstream.on('data', learnPid);

    let held: Buffer[] | undefined;
    client.on('data', (chunk: Buffer) => {
      if (held) {
        held.push(chunk);
        return;
      }
      const armed = this.armed;
      if (!armed || !chunk.includes(armed.message)) {
        upstream.write(chunk);
        return;
      }
      this.armed = undefined;
      held = [chunk];
      armed.found({
        pid: pid!,
        release: () => {
          const chunks = held ?? [];
          held = undefined;
          if (!upstream.destroyed) for (const sent of chunks) upstream.write(sent);
        },
      });
    });
  }
}
