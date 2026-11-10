import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config';
import { OrganisationState } from '../organisation/state';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { createCodeSender } from './code-senders';
import { CLOCK, CODE_SENDER, type Clock, type CodeSender } from './tokens';

/** Replaceable pieces, so tests can capture codes. */
export interface AuthOptions {
  codeSender?: CodeSender;
}

@Module({})
export class AuthModule {
  static register(options: AuthOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      // Global so other modules (project invitations) send email through the same sender.
      global: true,
      controllers: [AuthController, UsersController],
      providers: [
        AuthService,
        UsersService,
        OrganisationState,
        { provide: APP_GUARD, useClass: AuthGuard },
        {
          provide: CODE_SENDER,
          inject: [APP_CONFIG, CLOCK],
          useFactory: (config: AppConfig, clock: Clock) => options.codeSender ?? createCodeSender(config.email, clock),
        },
      ],
      exports: [AuthService, UsersService, CODE_SENDER, OrganisationState],
    };
  }
}
