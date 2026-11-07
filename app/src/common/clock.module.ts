import { Global, Module, type DynamicModule } from '@nestjs/common';
import { CLOCK, type Clock } from '../auth/tokens';

/** One clock for the whole application, replaceable in tests. */
@Global()
@Module({})
export class ClockModule {
  static forRoot(clock: Clock = () => new Date()): DynamicModule {
    return { module: ClockModule, providers: [{ provide: CLOCK, useValue: clock }], exports: [CLOCK] };
  }
}
