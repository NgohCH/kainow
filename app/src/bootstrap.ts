import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  options: AppOptions & { logger?: false | LoggerService | LogLevel[]; webDir?: string } = {},
): Promise<NestExpressApplication> {
  const { logger, webDir: webDirOverride, ...appOptions } = options;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, appOptions), {
    logger: logger ?? ['error', 'warn', 'log'],
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  // Everything is same-origin: the page, its scripts, its fonts and the API. Nothing is loaded from elsewhere.
  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // The review screen, built by `npm run build:web`. Served before the API routes, so it needs no sign-in;
  // it contains no data, and every API route still checks who is asking.
  const webDir = webDirOverride ?? process.env.WEB_DIR ?? resolve(__dirname, '../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    app.useStaticAssets(webDir, { index: 'index.html', maxAge: 0 });
  }
  return app;
}
