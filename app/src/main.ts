import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`kainow api listening on ${config.port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
