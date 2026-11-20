import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { PROTECTED_KEY, loadRequiredProtectedKey } from './protected-key';

/** Loads the protected key once at start. Inject it with `@Inject(PROTECTED_KEY)`: a `ProtectedKey`, or null when there is no usable key file. */
@Global()
@Module({
  providers: [{ provide: PROTECTED_KEY, inject: [APP_CONFIG], useFactory: (config: AppConfig) => loadRequiredProtectedKey(config.protectedKeyFile, config.requireProtectedKey, (m) => new Logger('ProtectedKey').warn(m)) }],
  exports: [PROTECTED_KEY],
})
export class ProtectedKeyModule {}
