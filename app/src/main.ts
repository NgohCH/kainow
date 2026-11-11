import 'reflect-metadata';
import { createApp } from './bootstrap';
import { appUrlWarning, loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const warning = appUrlWarning(process.env);
  if (warning) console.warn(warning);
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`kainow api listening on ${config.port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
