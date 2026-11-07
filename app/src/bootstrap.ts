import 'reflect-metadata';
import type { LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, type AppOptions } from './app.module';
import type { AppConfig } from './config';

/** Largest JSON body. Pasted notes can be up to 500,000 characters, which is about 2 MB in UTF-8. */
export const JSON_BODY_LIMIT = '4mb';

/** One place builds the application, so the real server and the tests share the same limits. */
export async function createApp(
  config: AppConfig,
  options: AppOptions & { logger?: false | LoggerService | LogLevel[] } = {},
): Promise<NestExpressApplication> {
  const { logger, ...appOptions } = options;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, appOptions), {
    logger: logger ?? ['error', 'warn', 'log'],
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  return app;
}
