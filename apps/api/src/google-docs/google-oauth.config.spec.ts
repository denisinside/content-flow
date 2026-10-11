import { describe, expect, it } from 'vitest';
import { loadGoogleOAuthRuntime } from './google-oauth.config.js';

const key = Buffer.alloc(32, 7).toString('base64');
const configured = {
  NODE_ENV: 'development', API_HOST: '127.0.0.1', API_PORT: '3000',
  GOOGLE_DOCS_CLIENT_ID: 'synthetic-client-id', GOOGLE_DOCS_CLIENT_SECRET: 'synthetic-client-secret',
  GOOGLE_DOCS_REDIRECT_URI: 'http://localhost:3000/api/v1/google-docs/oauth/callback',
  GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: key, GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION: '3',
};

describe('optional Google OAuth configuration', () => {
  it('leaves the existing API available when the integration is unconfigured', () => {
    expect(loadGoogleOAuthRuntime({ NODE_ENV: 'development' }).kind).toBe('disabled');
  });

  it('accepts the separate Google keyring and exact local API callback', () => {
    const runtime = loadGoogleOAuthRuntime(configured);
    expect(runtime.kind).toBe('configured');
    if (runtime.kind !== 'configured') return;
    const start = runtime.client.authorizationUrl('x'.repeat(43), 'y'.repeat(43));
    expect(new URL(start).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('fails closed for partial credentials, wrong API origin, and malformed keyring', () => {
    expect(loadGoogleOAuthRuntime({ ...configured, GOOGLE_DOCS_CLIENT_SECRET: undefined }).kind).toBe('disabled');
    expect(loadGoogleOAuthRuntime({ ...configured, GOOGLE_DOCS_REDIRECT_URI: 'http://localhost:3001/api/v1/google-docs/oauth/callback' }).kind).toBe('disabled');
    expect(loadGoogleOAuthRuntime({ ...configured, GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: 'bad' }).kind).toBe('disabled');
  });

  it('uses isolated TEST-prefixed configuration in test mode', () => {
    expect(loadGoogleOAuthRuntime({ ...configured, NODE_ENV: 'test' }).kind).toBe('disabled');
    const testEnv = Object.fromEntries(Object.entries(configured).filter(([name]) => name.startsWith('GOOGLE_DOCS_'))
      .map(([name, value]) => ['TEST_' + name, value]));
    expect(loadGoogleOAuthRuntime({ NODE_ENV: 'test', ...testEnv }).kind).toBe('configured');
  });
});
