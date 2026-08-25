/**
 * Instance listing (src/handlers/instance-handlers.ts).
 *
 * `../src/config.js` is mocked -- without it `listAvailableInstances` reads
 * `~/.confluence-config.json` and the suite becomes machine-dependent, reporting whatever
 * Confluence sites happen to be configured on the developer's laptop.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

type Instance = { name: string; domain: string; spaces?: string[]; isDefault: boolean };

const listAvailableInstances = jest.fn<() => Promise<Instance[]>>();

jest.mock('../src/config.js', () => ({
  __esModule: true,
  listAvailableInstances,
}));

import { handleListConfluenceInstances } from '../src/handlers/instance-handlers.js';

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

describe('handleListConfluenceInstances', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reports every configured instance with its domain, spaces and default flag', async () => {
    listAvailableInstances.mockResolvedValue([
      { name: 'onvex', domain: 'onvex.atlassian.net', spaces: ['APA', 'DOCS'], isDefault: true },
      { name: 'dev', domain: 'dev.atlassian.net', spaces: ['TEST'], isDefault: false },
    ]);

    const body = parse(await handleListConfluenceInstances());

    expect(body.totalInstances).toBe(2);
    expect(body.instances).toEqual([
      {
        name: 'onvex',
        domain: 'onvex.atlassian.net',
        spaces: ['APA', 'DOCS'],
        isDefault: true,
        status: 'connected',
      },
      {
        name: 'dev',
        domain: 'dev.atlassian.net',
        spaces: ['TEST'],
        isDefault: false,
        status: 'connected',
      },
    ]);
  });

  it('normalises a missing spaces list to an empty array', async () => {
    listAvailableInstances.mockResolvedValue([
      { name: 'solo', domain: 'solo.atlassian.net', isDefault: true },
    ]);

    const body = parse(await handleListConfluenceInstances());
    expect(body.instances[0].spaces).toEqual([]);
  });

  it('reports `connected` without having contacted Confluence', async () => {
    // The status is a static label, not a probe. Documented here so nobody reads a green
    // `list_confluence_instances` as evidence that credentials work.
    listAvailableInstances.mockResolvedValue([
      { name: 'onvex', domain: 'onvex.atlassian.net', isDefault: true },
    ]);

    const body = parse(await handleListConfluenceInstances());
    expect(body.instances[0].status).toBe('connected');
  });

  it('builds usage examples from the first instance when at least one exists', async () => {
    listAvailableInstances.mockResolvedValue([
      { name: 'onvex', domain: 'onvex.atlassian.net', isDefault: true },
      { name: 'dev', domain: 'dev.atlassian.net', isDefault: false },
    ]);

    const body = parse(await handleListConfluenceInstances());

    expect(body.usage.examples).toHaveLength(2);
    expect(body.usage.examples[0]).toMatchObject({
      tool: 'list_confluence_spaces',
      args: { instance: 'onvex' },
    });
    expect(body.usage.examples[1]).toMatchObject({
      tool: 'search_confluence_pages',
      args: { instance: 'onvex' },
    });
  });

  it('emits no usage examples when nothing is configured', async () => {
    listAvailableInstances.mockResolvedValue([]);

    const body = parse(await handleListConfluenceInstances());

    expect(body.totalInstances).toBe(0);
    expect(body.instances).toEqual([]);
    expect(body.usage.examples).toEqual([]);
  });

  it('always includes the config-file location and a worked example', async () => {
    listAvailableInstances.mockResolvedValue([]);

    const body = parse(await handleListConfluenceInstances());

    expect(body.configuration.location).toBe('~/.confluence-config.json');
    expect(body.configuration.format).toBe('JSON');
    expect(Object.keys(body.configuration.example.instances)).toEqual(['prod', 'dev']);
    expect(body.configuration.example.defaultInstance).toBe('prod');
  });

  it('returns actionable guidance instead of throwing when no config exists', async () => {
    listAvailableInstances.mockRejectedValue(
      new Error('No configuration found for Confluence instances')
    );

    const body = parse(await handleListConfluenceInstances());

    expect(body.error).toBe('No Confluence instances configured');
    expect(body.help).toContain('~/.confluence-config.json');
    expect(body.environmentVariables).toMatchObject({
      CONFLUENCE_DOMAIN: expect.any(String),
      CONFLUENCE_EMAIL: expect.any(String),
      CONFLUENCE_API_TOKEN: expect.any(String),
    });
  });

  it('raises InternalError for any other failure', async () => {
    listAvailableInstances.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(handleListConfluenceInstances()).rejects.toBeInstanceOf(McpError);
    await expect(handleListConfluenceInstances()).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('EACCES: permission denied'),
    });
  });

  it('stringifies a non-Error rejection in the InternalError message', async () => {
    listAvailableInstances.mockRejectedValue('config blew up' as never);

    await expect(handleListConfluenceInstances()).rejects.toMatchObject({
      message: expect.stringContaining('config blew up'),
    });
  });
});
