import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AuthModule, type AuthOptions } from './auth/auth.module';
import { APP_CONFIG, type AppConfig } from './config';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';

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

@Module({})
export class AppModule {
  /** Configuration is passed in so tests and the real entry point share one wiring. */
  static register(config: AppConfig, options: AuthOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, AuthModule.register(options)],
      controllers: [HealthController],
    };
  }
}
