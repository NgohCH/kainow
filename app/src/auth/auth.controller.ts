import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { ADDRESS_LIMITER, type AddressLimiter } from './address-limiter';
import { AnySignedInUser, Public, BeforeSetup } from './access';
import type { HttpRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { clearedCookie, sessionCookie } from './cookies';
import { SESSION_COOKIE } from './tokens';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/** Same answer whatever the account, so it says nothing about which addresses exist. */
const tooMany = (): HttpException =>
  new HttpException('Too many sign-in attempts from this network. Wait a few minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);

/** The caller's address as Express sees it (TRUST_PROXY decides whether a proxy may name it). */
const callerAddress = (req: { ip?: string; socket?: { remoteAddress?: string } }): string => req.ip ?? req.socket?.remoteAddress ?? 'unknown';

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

@BeforeSetup()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ADDRESS_LIMITER) private readonly limiter: AddressLimiter,
  ) {}

  /** Always answers the same way, whether or not the address has an account. */
  @Post('request-code')
  @Public()
  @HttpCode(202)
  async requestCode(@Body() body: unknown, @Req() req: HttpRequest): Promise<{ status: 'ok' }> {
    const email = field(body, 'email');
    if (typeof email !== 'string') {
      throw new BadRequestException('email is required');
    }
    if (!this.limiter.take(callerAddress(req), 'request')) throw tooMany();
    await this.auth.requestCode(email);
    return { status: 'ok' };
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  async verify(@Body() body: unknown, @Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    const email = field(body, 'email');
    const code = field(body, 'code');
    if (typeof email !== 'string' || typeof code !== 'string') {
      throw new BadRequestException('email and code are required');
    }
    // Checked before the code is looked at, so a blocked address cannot keep guessing or locking accounts.
    const address = callerAddress(req);
    if (this.limiter.blocked(address, 'failure')) throw tooMany();
    const result = await this.auth.verifyCode(email, code);
    if (!result) {
      this.limiter.take(address, 'failure');
      throw new UnauthorizedException('Invalid or expired code');
    }
    const maxAge = this.config.auth.sessionHours * 3600;
    res.setHeader('Set-Cookie', sessionCookie(SESSION_COOKIE, result.token, maxAge, this.config.cookieSecure));
    const session = await this.auth.resolveSession(result.token);
    return { user: result.user, csrfToken: session ? this.auth.csrfToken(session.sessionId) : null };
  }

  @Get('me')
  @AnySignedInUser()
  me(@Req() req: HttpRequest) {
    return { user: req.auth?.user, csrfToken: req.auth ? this.auth.csrfToken(req.auth.sessionId) : null };
  }

  @Post('logout-all')
  @AnySignedInUser()
  @HttpCode(204)
  async logoutAll(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<void> {
    if (req.auth) {
      await this.auth.signOutAll(req.auth);
    }
    res.setHeader('Set-Cookie', clearedCookie(SESSION_COOKIE, this.config.cookieSecure));
  }

  @Post('logout')
  @AnySignedInUser()
  @HttpCode(204)
  async logout(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<void> {
    if (req.auth) {
      await this.auth.signOut(req.auth);
    }
    res.setHeader('Set-Cookie', clearedCookie(SESSION_COOKIE, this.config.cookieSecure));
  }
}
