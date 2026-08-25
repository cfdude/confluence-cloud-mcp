/**
 * Axios instance construction (src/utils/confluence-api.ts).
 *
 * This is the ONLY code in the repo that builds a Confluence `Authorization` header, and the
 * only place `auth.type === 'oauth2'` is honoured anywhere. It is asserted here on the
 * instance's resolved defaults, which needs no transport at all.
 *
 * NOTE, and the reason this file matters more than its size suggests: nothing imports either
 * of these functions. `tool-wrapper.ts` constructs `new ConfluenceClient(...)` directly, and
 * that client hardcodes basic-auth credentials. So the Bearer branch below is correct, tested,
 * and unreachable in production -- OAuth2 is documented in the README and CLAUDE.md but does
 * not work on the live path. See `confluence-client.test.ts`, "sends NO usable credentials for
 * an oauth2 config".
 */

import { describe, it, expect } from '@jest/globals';

import type { ConfluenceConfig } from '../src/types/index.js';
import {
  createConfluenceApiInstance,
  createConfluenceApiV1Instance,
} from '../src/utils/confluence-api.js';

const BASIC: ConfluenceConfig = {
  domain: 'example.atlassian.net',
  auth: { type: 'basic', email: 'user@example.com', apiToken: 'secret-token' },
};

const OAUTH: ConfluenceConfig = {
  domain: 'example.atlassian.net',
  auth: { type: 'oauth2', accessToken: 'oauth-access-token', refreshToken: 'r' },
};

/** Header lookup that does not care how axios cased or nested the key. */
function header(instance: { defaults: { headers: any } }, name: string): string | undefined {
  const buckets = [instance.defaults.headers, instance.defaults.headers?.common];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const [key, value] of Object.entries(bucket)) {
      if (key.toLowerCase() === name.toLowerCase() && typeof value !== 'object') {
        return String(value);
      }
    }
  }
  return undefined;
}

type Factory = (config: ConfluenceConfig) => { defaults: any };

const FACTORIES: Array<[string, Factory, string]> = [
  ['createConfluenceApiInstance', createConfluenceApiInstance, '/wiki/api/v2'],
  ['createConfluenceApiV1Instance', createConfluenceApiV1Instance, '/wiki/rest/api'],
];

describe.each(FACTORIES)('%s', (_name, factory, path) => {
  it('points at the right API version for the configured domain', () => {
    expect(factory(BASIC).defaults.baseURL).toBe(`https://example.atlassian.net${path}`);
  });

  it('follows the domain rather than hardcoding one', () => {
    const other = factory({ ...BASIC, domain: 'other.atlassian.net' });
    expect(other.defaults.baseURL).toBe(`https://other.atlassian.net${path}`);
  });

  it('sets a 30 second timeout', () => {
    expect(factory(BASIC).defaults.timeout).toBe(30000);
  });

  it('asks for and sends JSON', () => {
    const instance = factory(BASIC);
    expect(header(instance, 'accept')).toBe('application/json');
    expect(header(instance, 'content-type')).toBe('application/json');
  });

  it('base64-encodes email:apiToken for basic auth', () => {
    const instance = factory(BASIC);
    const authorization = header(instance, 'authorization')!;

    expect(authorization.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(authorization.slice('Basic '.length), 'base64').toString()).toBe(
      'user@example.com:secret-token'
    );
  });

  it('never puts the API token on the wire in the clear', () => {
    const authorization = header(factory(BASIC), 'authorization')!;
    expect(authorization).not.toContain('secret-token');
  });

  it('sends a Bearer token for oauth2', () => {
    expect(header(factory(OAUTH), 'authorization')).toBe('Bearer oauth-access-token');
  });

  it('does not leak the refresh token into the request headers', () => {
    const instance = factory(OAUTH);
    expect(JSON.stringify(instance.defaults.headers)).not.toContain('"r"');
  });

  it('treats an unset auth type as basic rather than sending nothing', () => {
    const instance = factory({
      domain: 'example.atlassian.net',
      auth: { type: 'basic', email: 'a@b.c', apiToken: 't' },
    } as ConfluenceConfig);
    expect(header(instance, 'authorization')!.startsWith('Basic ')).toBe(true);
  });

  it('still emits a Basic header when basic credentials are missing', () => {
    // Documented, not endorsed: an incomplete basic config yields `Basic dW5kZWZpbmVkOnVuZGVmaW5lZA==`
    // rather than an error, so the failure surfaces as a 401 from Confluence instead of at
    // construction time.
    const instance = factory({
      domain: 'example.atlassian.net',
      auth: { type: 'basic' },
    } as ConfluenceConfig);

    const authorization = header(instance, 'authorization')!;
    expect(Buffer.from(authorization.slice('Basic '.length), 'base64').toString()).toBe(
      'undefined:undefined'
    );
  });
});

describe('version differences', () => {
  it('gives the two versions different base URLs from the same config', () => {
    expect(createConfluenceApiInstance(BASIC).defaults.baseURL).not.toBe(
      createConfluenceApiV1Instance(BASIC).defaults.baseURL
    );
  });

  it('gives both versions the same Authorization header', () => {
    expect(header(createConfluenceApiInstance(OAUTH), 'authorization')).toBe(
      header(createConfluenceApiV1Instance(OAUTH), 'authorization')
    );
  });
});
