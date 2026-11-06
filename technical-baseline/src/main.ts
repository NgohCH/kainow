// Spike: confirm the pinned NestJS version boots and serves a route.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`listening on ${port}`);
}

void bootstrap();
