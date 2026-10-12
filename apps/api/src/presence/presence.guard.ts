import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DependencyHealthService } from '@contextflow/backend';
import { CsrfProtection, cookieValue, SESSION_COOKIE, setCookie } from '../auth/csrf.js';
import { SessionService, type SessionUser } from '../auth/session-service.js';
import { tokenDigest, validOpaqueToken } from '../auth/session-crypto.js';

export type PresenceRequest = IncomingMessage & { sessionUser: SessionUser; presenceSessionId: string };

@Injectable()
export class PresenceSessionGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(DependencyHealthService) private readonly health: DependencyHealthService,
    @Inject(CsrfProtection) private readonly csrf: CsrfProtection,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PresenceRequest>();
    const response = context.switchToHttp().getResponse<ServerResponse>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '');
    if (unsafe) this.csrf.require(request);

    const cookie = cookieValue(request, SESSION_COOKIE);
    const checked = await this.sessions.check(cookie, false);
    if (checked.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (checked.kind !== 'active' || !validOpaqueToken(cookie)) {
      setCookie(response, SESSION_COOKIE, '', 0);
      throw new UnauthorizedException('Session expired');
    }
    const sessions = await this.health.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM contextflow."AppSession"
      WHERE "cookieDigest" = ${tokenDigest(cookie)} AND "userId" = ${checked.user.id}::uuid
        AND "revokedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP`;
    if (!sessions[0]) throw new UnauthorizedException('Session expired');
    request.sessionUser = checked.user;
    request.presenceSessionId = sessions[0].id;
    return true;
  }
}
