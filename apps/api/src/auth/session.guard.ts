import { Injectable, Inject, UnauthorizedException, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionService, type SessionUser } from './session-service.js';
import { CsrfProtection, cookieValue, SESSION_COOKIE, setCookie } from './csrf.js';

export type AuthenticatedRequest = IncomingMessage & { sessionUser: SessionUser };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(CsrfProtection) private readonly csrf: CsrfProtection) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<ServerResponse>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '');
    if (unsafe) this.csrf.require(request);
    const session = await this.sessions.check(cookieValue(request, SESSION_COOKIE), unsafe);
    if (session.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (session.kind !== 'active') {
      setCookie(response, SESSION_COOKIE, '', 0);
      throw new UnauthorizedException('Session expired');
    }
    request.sessionUser = session.user;
    return true;
  }
}
