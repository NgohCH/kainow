import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AnySignedInUser, Public, RequireAction } from './access';
import { AuthGuard, type HttpRequest } from './auth.guard';
import type { AuthService } from './auth.service';
import { ACTIONS } from './permissions';

class Sample {
  @Public() open(): void {}
  @AnySignedInUser() anyone(): void {}
  undeclared(): void {}
}

const sessions: Record<string, { role: string }> = {
  admin: { role: 'enterprise_administrator' },
  stranger: { role: 'nobody' },
};

const fakeAuth = {
  async resolveSession(token: string) {
    const found = sessions[token];
    return found ? { user: { id: 'u1', email: 'u@example.org', displayName: 'U', role: found.role }, sessionId: 's1' } : null;
  },
} as unknown as AuthService;

const guard = new AuthGuard(new Reflector(), fakeAuth);

function contextFor(handler: () => void, cookie?: string): { ctx: ExecutionContext; req: HttpRequest } {
  const req: HttpRequest = { method: 'GET', headers: cookie ? { cookie: `kainow_session=${cookie}` } : {} };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Sample,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function handlerRequiring(action: (typeof ACTIONS)[number]): () => void {
  class Dynamic {
    run(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Dynamic.prototype, 'run') as PropertyDescriptor;
  RequireAction(action)(Dynamic.prototype, 'run', descriptor);
  return Dynamic.prototype.run;
}

test('a route that declares no protection is refused, even for a signed-in administrator', async () => {
  const { ctx } = contextFor(Sample.prototype.undeclared, 'admin');
  await assert.rejects(guard.canActivate(ctx), ForbiddenException);
});

test('a public route needs no session', async () => {
  const { ctx } = contextFor(Sample.prototype.open);
  assert.equal(await guard.canActivate(ctx), true);
});

test('a signed-in-only route refuses no cookie and an unknown token, and accepts a valid session', async () => {
  await assert.rejects(guard.canActivate(contextFor(Sample.prototype.anyone).ctx), UnauthorizedException);
  await assert.rejects(guard.canActivate(contextFor(Sample.prototype.anyone, 'made-up').ctx), UnauthorizedException);
  const { ctx, req } = contextFor(Sample.prototype.anyone, 'stranger');
  assert.equal(await guard.canActivate(ctx), true);
  assert.equal(req.auth?.user.role, 'nobody');
});

for (const action of ACTIONS) {
  test(`${action}: allowed for the administrator, denied without a session and for another role`, async () => {
    const handler = handlerRequiring(action);

    const allowed = contextFor(handler, 'admin');
    assert.equal(await guard.canActivate(allowed.ctx), true);
    assert.equal(allowed.req.auth?.user.role, 'enterprise_administrator');

    await assert.rejects(guard.canActivate(contextFor(handler).ctx), UnauthorizedException);
    await assert.rejects(guard.canActivate(contextFor(handler, 'made-up').ctx), UnauthorizedException);
    await assert.rejects(guard.canActivate(contextFor(handler, 'stranger').ctx), ForbiddenException);
  });
}
