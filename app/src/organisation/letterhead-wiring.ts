import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { CODE_SENDER, type CodeSender } from '../auth/tokens';
import type { Letterhead } from './organisation.service';
import { OrganisationProfileService } from './organisation.service';

/** Gives the email sender the organisation's letterhead once the app starts (senders without one ignore it). */
@Injectable()
export class LetterheadWiring implements OnModuleInit {
  constructor(
    @Inject(CODE_SENDER) private readonly sender: CodeSender & { useLetterhead?: (source: () => Promise<Letterhead>) => void },
    private readonly organisation: OrganisationProfileService,
  ) {}

  onModuleInit(): void {
    this.sender.useLetterhead?.(() => this.organisation.letterhead('email'));
  }
}
