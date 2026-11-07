import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { createCodeSender } from './code-senders';
import { CLOCK, CODE_SENDER, type Clock, type CodeSender } from './tokens';

/** Replaceable pieces, so tests can capture codes and control time. */
export interface AuthOptions {
  codeSender?: CodeSender;
  clock?: Clock;
}

@Module({})
export class AuthModule {
  static register(options: AuthOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController, UsersController],
      providers: [
        AuthService,
        UsersService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: CLOCK, useValue: options.clock ?? (() => new Date()) },
        {
          provide: CODE_SENDER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => options.codeSender ?? createCodeSender(config.codeDelivery),
        },
      ],
      exports: [AuthService, UsersService, CLOCK],
    };
  }
}
