import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString } from 'class-validator';

import { DomainError } from '../../src/common/domain-error';

class ValidatedDto {
  @IsString()
  name!: string;
}

/** e2e-only routes exercising the error contract and throttling. */
@Controller('api/_test')
export class TestSupportController {
  @Get('boom')
  boom(): never {
    throw new Error('kaboom');
  }

  @Get('domain-error')
  domainError(): never {
    throw new DomainError('nope');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return { received: body };
  }

  @Post('validated')
  validated(@Body() body: ValidatedDto): ValidatedDto {
    return body;
  }

  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get('limited')
  limited(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [TestSupportController] })
export class TestSupportModule {}
