import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AuthModule, type AuthOptions } from './auth/auth.module';
import type { Clock } from './auth/tokens';
import { ClockModule } from './common/clock.module';
import { APP_CONFIG, type AppConfig } from './config';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { ExtractionModule } from './extraction/extraction.module';
import type { ExtractionQueue } from './extraction/queue';
import { NotesModule } from './notes/notes.module';
import { SpendModule } from './spend/spend.module';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/** Replaceable pieces, so tests can capture sign-in codes and control time. */
export interface AppOptions extends AuthOptions {
  clock?: Clock;
  /** Tests only: replaces the pg-boss queue that carries runs to the worker. */
  extractionQueue?: ExtractionQueue;
}

@Module({})
export class AppModule {
  /** Configuration is passed in so tests and the real entry point share one wiring. */
  static register(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ClockModule.forRoot(options.clock),
        DatabaseModule,
        AuthModule.register({ codeSender: options.codeSender }),
        SpendModule,
        NotesModule,
        ExtractionModule.register(options.extractionQueue),
      ],
      controllers: [HealthController],
    };
  }
}
