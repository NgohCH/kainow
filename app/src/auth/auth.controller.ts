import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { AnySignedInUser, Public } from './access';
import type { HttpRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { clearedCookie, sessionCookie } from './cookies';
import { SESSION_COOKIE } from './tokens';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Always answers the same way, whether or not the address has an account. */
  @Post('request-code')
  @Public()
  @HttpCode(202)
  async requestCode(@Body() body: unknown): Promise<{ status: 'ok' }> {
    const email = field(body, 'email');
    if (typeof email !== 'string') {
      throw new BadRequestException('email is required');
    }
    await this.auth.requestCode(email);
    return { status: 'ok' };
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: HttpResponse) {
    const email = field(body, 'email');
    const code = field(body, 'code');
    if (typeof email !== 'string' || typeof code !== 'string') {
      throw new BadRequestException('email and code are required');
    }
    const result = await this.auth.verifyCode(email, code);
    if (!result) {
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
