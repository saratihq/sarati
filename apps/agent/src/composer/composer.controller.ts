import { Body, Controller, HttpCode, HttpException, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request, Response } from 'express';

import { callerSubOf, callerTokenOf, ComposerAuthGuard } from './composer-auth.guard';
import { ComposerEnabledGuard } from './composer-enabled.guard';
import { ComposerService } from './composer.service';
import type { AttachEvent, WorkflowIr } from './protocol';
import { callerOf } from './caller-context';

class StreamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  message!: string;

  /** Continue an existing composer session; omit to open a new one. */
  @IsOptional()
  @IsUUID()
  session_id?: string;

  /** The workflow being edited (seeds the draft when no ir is sent). */
  @IsOptional()
  @IsString()
  workflow_id?: string;

  /** The editor's current canvas document. */
  @IsOptional()
  @IsObject()
  ir?: WorkflowIr | null;
}

class AnswerDto {
  @IsUUID()
  session_id!: string;

  @IsUUID()
  question_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  answer!: string;
}

class TokenDto {
  @IsUUID()
  session_id!: string;
}

class AttachDto {
  /** Same-tab fast path: the live in-memory session, when the client still has its id. */
  @IsOptional()
  @IsUUID()
  session_id?: string;

  /** Identity keying: the caller's durable (user, workflow) thread. */
  @IsOptional()
  @IsUUID()
  workflow_id?: string;

  /** Identity keying for the pre-save compose page: the user's ONE scratch thread. */
  @IsOptional()
  @IsBoolean()
  scratch?: boolean;

  /** Replay everything after this seq (omit/0 = the full thread, from seq 1). */
  @IsOptional()
  @IsInt()
  @Min(0)
  last_event_seq?: number;
}

/**
 * The composer session endpoints (Clerk-authenticated; MOCK_AUTH bypass for
 * dev): POST /stream sends a message and receives sequenced SSE; POST /attach
 * replays the caller's thread — by live session id, or by (user, workflow)
 * identity from the durable event log (page refresh, service restart) — and
 * rejoins a live turn; POST /answer resolves a pending clarifying question.
 * Every SSE frame carries its seq as the `id:` line.
 *
 * ComposerEnabledGuard is listed first on purpose: an instance without the
 * composer's credentials must 503 "not configured" before auth can 401 it.
 */
@Controller('api/composer')
@UseGuards(ComposerEnabledGuard, ComposerAuthGuard)
export class ComposerController {
  constructor(private readonly composer: ComposerService) {}

  @Post('stream')
  async stream(@Req() req: Request, @Res() res: Response, @Body() body: StreamDto): Promise<void> {
    await this.pipe(
      req,
      res,
      this.composer.stream(
        body,
        this.gone(req).signal,
        callerTokenOf(req),
        callerOf(req).orgId ?? null,
        callerSubOf(req),
      ),
    );
  }

  /** Reattach after a refresh/restart: replay the thread, then continue a live turn. */
  /** Clear the caller's conversation for a workflow (or the scratch thread). */
  @Post('clear')
  async clear(
    @Req() req: Request,
    @Body() body: { workflow_id?: string; scratch?: boolean },
  ): Promise<{ cleared: boolean }> {
    if (!body.workflow_id && body.scratch !== true) {
      throw new HttpException({ message: 'One of workflow_id or scratch is required.' }, 400);
    }
    const sub = callerSubOf(req);
    if (!sub) return { cleared: false }; // unkeyed caller (mock-auth off-path) — nothing durable to clear
    return this.composer.clearThread(sub, body.workflow_id ?? null);
  }

  @Post('attach')
  async attach(@Req() req: Request, @Res() res: Response, @Body() body: AttachDto): Promise<void> {
    if (!body.session_id && !body.workflow_id && body.scratch !== true) {
      throw new HttpException({ message: 'One of session_id, workflow_id, or scratch is required.' }, 400);
    }
    await this.pipe(
      req,
      res,
      this.composer.attach(
        {
          sessionId: body.session_id,
          workflowId: body.workflow_id ?? null,
          scratch: body.scratch === true,
          lastSeq: body.last_event_seq ?? 0,
        },
        this.gone(req).signal,
        callerSubOf(req),
      ),
    );
  }

  /** Refresh the session's caller token mid-turn (Clerk rotates ~every minute). */
  @HttpCode(200)
  @Post('token')
  token(@Req() req: Request, @Body() body: TokenDto): { status: string } {
    if (!this.composer.refreshToken(body.session_id, callerTokenOf(req))) {
      throw new HttpException({ message: 'Unknown or expired session.' }, 404);
    }
    return { status: 'refreshed' };
  }

  /** First answer wins; a question that expired, was answered, or belongs elsewhere is a 404. */
  @HttpCode(200)
  @Post('answer')
  answer(@Req() req: Request, @Body() body: AnswerDto): { status: string } {
    const accepted = this.composer.answerQuestion(
      body.session_id,
      body.question_id,
      body.answer,
      callerTokenOf(req),
    );
    if (!accepted) {
      throw new HttpException({ message: 'Unknown or already-answered question.' }, 404);
    }
    return { status: 'answered' };
  }

  /** Client disconnect aborts the agent turn — an abandoned tab must not keep spending tokens. */
  private gone(req: Request): AbortController {
    const gone = new AbortController();
    req.on('close', () => gone.abort());
    return gone;
  }

  private async pipe(req: Request, res: Response, events: AsyncGenerator<AttachEvent>): Promise<void> {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    for await (const evt of events) {
      if (res.writableEnded) break;
      res.write(`id: ${evt.seq}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }
}
