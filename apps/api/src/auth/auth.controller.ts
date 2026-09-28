import { BadRequestException, Body, Controller, Get, Inject, Patch, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AuthProvider, ProviderFailure } from './auth-provider.js';
import { AuthRateLimit } from './auth-rate-limit.js';
import { CsrfProtection, SESSION_COOKIE, cookieValue, setCookie } from './csrf.js';
import { SessionService } from './session-service.js';
import { MAX_IDLE_TIMEOUT_MINUTES } from './session-service.js';
import { SessionGuard, type AuthenticatedRequest } from './session.guard.js';
import type { AuthConfig } from './auth-config.js';

const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) }).strict();
const registrationInput = loginInput.extend({ password: z.string().min(8).max(128), displayName: z.string().trim().min(1).max(80).optional() });
const preferencesInput = z.object({ idleTimeoutMinutes: z.number().int().min(1).max(MAX_IDLE_TIMEOUT_MINUTES) }).strict();

@ApiTags('identity')
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(AuthProvider) private readonly provider: AuthProvider,
    @Inject(CsrfProtection) private readonly csrf: CsrfProtection, @Inject(AuthRateLimit) private readonly limit: AuthRateLimit,
    @Inject('AUTH_CONFIG') private readonly config: AuthConfig) {}

  private noStore(response: ServerResponse): void { response.setHeader('Cache-Control', 'no-store'); response.setHeader('Pragma', 'no-cache'); }
  private clear(response: ServerResponse): void { setCookie(response, SESSION_COOKIE, '', 0); }

  @Get('session')
  @ApiOperation({ summary: 'Verify the opaque BFF session without extending idle time' })
  @ApiResponse({ status: 200, description: 'Authenticated user or signed-out state and CSRF token. No provider tokens.' })
  async session(@Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    this.noStore(response);
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!cookie) return { authenticated: false, csrfToken: this.csrf.token(request, response, undefined) };
    const result = await this.sessions.check(cookie);
    if (result.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (result.kind === 'expired') {
      this.clear(response);
      return { authenticated: false, reason: 'expired', csrfToken: this.csrf.token(request, response, undefined, true) };
    }
    return { authenticated: true, user: result.user, csrfToken: this.csrf.token(request, response, cookie) };
  }

  @Get('preferences')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('__Host-contextflow')
  @ApiOperation({ summary: 'Read the signed-in user’s personal idle timeout in minutes' })
  @ApiResponse({ status: 200, description: 'Saved personal idle timeout; no provider tokens' })
  preferences(@Req() request: AuthenticatedRequest) {
    return this.sessions.preferences(request.sessionUser.id);
  }

  @Patch('preferences')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('__Host-contextflow')
  @ApiOperation({ summary: 'Save the signed-in user’s personal idle timeout' })
  @ApiBody({ schema: { type: 'object', required: ['idleTimeoutMinutes'], additionalProperties: false,
    properties: { idleTimeoutMinutes: { type: 'integer', minimum: 1, maximum: MAX_IDLE_TIMEOUT_MINUTES } } } })
  @ApiResponse({ status: 200, description: 'Saved personal idle timeout; concurrent checks use the next committed setting' })
  updatePreferences(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = preferencesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid session preference');
    return this.sessions.updatePreferences(request.sessionUser.id, parsed.data.idleTimeoutMinutes);
  }

  @Post('login')
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password', maxLength: 128 } } } })
  @ApiResponse({ status: 201, description: 'Authenticated BFF session and rotated CSRF token' })
  async login(@Body() body: unknown, @Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    this.noStore(response); this.csrf.require(request);
    const parsed = loginInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid authentication input');
    await this.limit.require(request.socket.remoteAddress ?? 'unknown', parsed.data.email);
    try {
      const identity = await this.provider.login(parsed.data.email, parsed.data.password);
      const created = await this.sessions.create(identity, undefined, cookieValue(request, SESSION_COOKIE));
      setCookie(response, SESSION_COOKIE, created.cookie, this.config.absoluteTtlMs / 1000);
      return { authenticated: true, user: created.user, csrfToken: this.csrf.token(request, response, created.cookie, true) };
    } catch (error) {
      if (error instanceof ProviderFailure) {
        if (error.unavailable) throw new ServiceUnavailableException('Authentication temporarily unavailable');
        throw new UnauthorizedException('Unable to sign in with these credentials');
      }
      throw error;
    }
  }

  @Post('register')
  @ApiBody({ schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password', minLength: 8, maxLength: 128 }, displayName: { type: 'string', maxLength: 80 } } } })
  @ApiResponse({ status: 201, description: 'Session or generic email confirmation instructions' })
  async register(@Body() body: unknown, @Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    this.noStore(response); this.csrf.require(request);
    const parsed = registrationInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid registration input');
    await this.limit.require(request.socket.remoteAddress ?? 'unknown', parsed.data.email);
    try {
      const identity = await this.provider.register(parsed.data.email, parsed.data.password, parsed.data.displayName);
      if (!identity) return { authenticated: false, confirmationRequired: true,
        message: 'Перевірте пошту для підтвердження адреси. Після підтвердження можна увійти.',
        csrfToken: this.csrf.token(request, response, cookieValue(request, SESSION_COOKIE)) };
      const created = await this.sessions.create(identity, parsed.data.displayName, cookieValue(request, SESSION_COOKIE));
      setCookie(response, SESSION_COOKIE, created.cookie, this.config.absoluteTtlMs / 1000);
      return { authenticated: true, user: created.user, csrfToken: this.csrf.token(request, response, created.cookie, true) };
    } catch (error) {
      if (error instanceof ProviderFailure) {
        if (error.unavailable) throw new ServiceUnavailableException('Authentication temporarily unavailable');
        throw new BadRequestException('Unable to register with these details');
      }
      throw error;
    }
  }

  @Post('logout')
  @ApiResponse({ status: 201, description: 'Locally revoked session, cleared cookie and fresh pre-login CSRF token' })
  async logout(@Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    this.noStore(response); this.csrf.require(request);
    await this.sessions.logout(cookieValue(request, SESSION_COOKIE));
    this.clear(response);
    return { authenticated: false, csrfToken: this.csrf.token(request, response, undefined, true) };
  }

  @Post('activity')
  @ApiResponse({ status: 201, description: 'Record authenticated user interaction; at most once per 30 seconds' })
  async activity(@Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    this.noStore(response); this.csrf.require(request);
    const result = await this.sessions.check(cookieValue(request, SESSION_COOKIE), true);
    if (result.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (result.kind === 'expired') { this.clear(response); throw new UnauthorizedException('Session expired'); }
    return { ok: true };
  }
}
