import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  // Nest's built-in bodyParser is off: configureApp installs the JSON parser
  // itself so prod and the e2e harness share one pipeline.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const env = configureApp(app);
  await app.listen(env.port);
}

void bootstrap();
