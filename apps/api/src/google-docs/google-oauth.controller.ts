import { Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { GoogleOAuthService } from './google-oauth.service.js';

@ApiTags('Google Docs connection')
@Controller('api/v1/google-docs')
@UseGuards(SessionGuard)
@ApiCookieAuth('__Host-contextflow')
export class GoogleOAuthController {
  constructor(@Inject(GoogleOAuthService) private readonly oauth: GoogleOAuthService) {}

  @Post('oauth/start')
  @ApiOperation({ summary: 'Start a personal Google Docs OAuth connection' })
  @ApiResponse({ status: 201, description: 'Short-lived authorization URL and expiry; no provider credentials' })
  start(@Req() request: AuthenticatedRequest): ReturnType<GoogleOAuthService['start']> { return this.oauth.start(request); }

  @Get('oauth/callback')
  @ApiOperation({ summary: 'Complete the bound Google OAuth callback' })
  @ApiResponse({ status: 200, description: 'Safe personal Google connection metadata only' })
  callback(@Req() request: AuthenticatedRequest, @Query() query: unknown, @Res({ passthrough: true }) response: ServerResponse): ReturnType<GoogleOAuthService['callback']> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return this.oauth.callback(request, query);
  }

  @Get('connections')
  @ApiOperation({ summary: 'List the signed-in user’s personal Google connections' })
  @ApiResponse({ status: 200, description: 'Safe metadata only; provider tokens are never returned' })
  list(@Req() request: AuthenticatedRequest): ReturnType<GoogleOAuthService['list']> { return this.oauth.list(request); }

  @Post('connections/:id/disconnect')
  @ApiOperation({ summary: 'Revoke a personal Google connection locally and request provider revocation' })
  @ApiResponse({ status: 201, description: 'Local credentials cleared; provider revocation result is categorical' })
  disconnect(@Req() request: AuthenticatedRequest, @Param('id') id: string): ReturnType<GoogleOAuthService['disconnect']> { return this.oauth.disconnect(request, id); }
}
