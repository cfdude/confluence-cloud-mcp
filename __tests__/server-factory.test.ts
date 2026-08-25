/**
 * Server factory + tool dispatch (src/server.ts).
 *
 * Driven through a REAL MCP transport (`InMemoryTransport.createLinkedPair()`) and a real
 * SDK `Client`, not by poking at the Server's private request handlers. That distinction is
 * the point of this file: before it, no test in the repo instantiated a transport at all, so
 * a protocol-level regression -- a malformed tool schema, a tool registered but not
 * dispatched, an exception escaping as something other than an McpError -- passed the whole
 * suite.
 *
 * Every handler module is mocked. This file asserts ROUTING and PROTOCOL SHAPE; handler
 * behaviour is covered by the per-handler suites.
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

type HandlerResult = { content: Array<{ type: string; text: string }> };

/** Every mocked handler returns a marker naming itself, so routing is observable. */
function marker(name: string): HandlerResult {
  return { content: [{ type: 'text', text: `handled:${name}` }] };
}

const handleListConfluenceInstances = jest.fn(async () => marker('list_confluence_instances'));

const handleListConfluenceSpaces = jest.fn(async () => marker('list_confluence_spaces'));
const handleGetConfluenceSpace = jest.fn(async () => marker('get_confluence_space'));

const handleListConfluencePages = jest.fn(async () => marker('list_confluence_pages'));
const handleGetConfluencePage = jest.fn(async () => marker('get_confluence_page'));
const handleFindConfluencePage = jest.fn(async () => marker('find_confluence_page'));
const handleCreateConfluencePage = jest.fn(async () => marker('create_confluence_page'));
const handleUpdateConfluencePage = jest.fn(async () => marker('update_confluence_page'));
const handleMoveConfluencePage = jest.fn(async () => marker('move_confluence_page'));

const handleReplaceConfluenceSection = jest.fn(async () => marker('replace_confluence_section'));
const handleAppendConfluenceSection = jest.fn(async () => marker('append_confluence_section'));
const handleInsertConfluenceSection = jest.fn(async () => marker('insert_confluence_section'));

const handleValidateConfluenceContent = jest.fn(async () => marker('validate_confluence_content'));

const handleSearchConfluencePages = jest.fn(async () => marker('search_confluence_pages'));
const handleGetConfluenceLabels = jest.fn(async () => marker('get_confluence_labels'));
const handleAddConfluenceLabel = jest.fn(async () => marker('add_confluence_label'));
const handleRemoveConfluenceLabel = jest.fn(async () => marker('remove_confluence_label'));

jest.mock('../src/handlers/instance-handlers.js', () => ({
  __esModule: true,
  handleListConfluenceInstances,
}));

jest.mock('../src/handlers/space-handlers.js', () => ({
  __esModule: true,
  handleListConfluenceSpaces,
  handleGetConfluenceSpace,
}));

jest.mock('../src/handlers/page-handlers.js', () => ({
  __esModule: true,
  handleListConfluencePages,
  handleGetConfluencePage,
  handleFindConfluencePage,
  handleCreateConfluencePage,
  handleUpdateConfluencePage,
  handleMoveConfluencePage,
}));

jest.mock('../src/handlers/section-handlers.js', () => ({
  __esModule: true,
  handleReplaceConfluenceSection,
  handleAppendConfluenceSection,
  handleInsertConfluenceSection,
}));

jest.mock('../src/handlers/validation-handlers.js', () => ({
  __esModule: true,
  handleValidateConfluenceContent,
}));

jest.mock('../src/handlers/search-label-handlers.js', () => ({
  __esModule: true,
  handleSearchConfluencePages,
  handleGetConfluenceLabels,
  handleAddConfluenceLabel,
  handleRemoveConfluenceLabel,
}));

import { toolSchemas } from '../src/schemas/tool-schemas.js';
import { createConfluenceServer } from '../src/server.js';

/**
 * Tool name -> the handler the dispatch switch is supposed to reach.
 *
 * This table is the executable statement of the routing contract. It is checked for
 * completeness against `toolSchemas` below, so adding a tool to the schemas without adding
 * it here fails rather than silently going untested.
 */
const ROUTES: Array<[string, jest.Mock, Record<string, unknown>]> = [
  ['list_confluence_instances', handleListConfluenceInstances as unknown as jest.Mock, {}],
  ['list_confluence_spaces', handleListConfluenceSpaces as unknown as jest.Mock, { limit: 10 }],
  ['get_confluence_space', handleGetConfluenceSpace as unknown as jest.Mock, { spaceId: '1' }],
  ['list_confluence_pages', handleListConfluencePages as unknown as jest.Mock, { spaceId: '1' }],
  ['get_confluence_page', handleGetConfluencePage as unknown as jest.Mock, { pageId: '2' }],
  ['find_confluence_page', handleFindConfluencePage as unknown as jest.Mock, { title: 'T' }],
  [
    'create_confluence_page',
    handleCreateConfluencePage as unknown as jest.Mock,
    { spaceId: '1', title: 'T', content: '<p>x</p>' },
  ],
  [
    'update_confluence_page',
    handleUpdateConfluencePage as unknown as jest.Mock,
    { pageId: '2', content: '<p>x</p>', expectedVersion: 3 },
  ],
  [
    'replace_confluence_section',
    handleReplaceConfluenceSection as unknown as jest.Mock,
    { pageId: '2', heading: 'H', content: '<p>x</p>', expectedVersion: 3 },
  ],
  [
    'append_confluence_section',
    handleAppendConfluenceSection as unknown as jest.Mock,
    { pageId: '2', heading: 'H', content: '<p>x</p>', expectedVersion: 3 },
  ],
  [
    'insert_confluence_section',
    handleInsertConfluenceSection as unknown as jest.Mock,
    { pageId: '2', heading: 'H', content: '<p>x</p>', expectedVersion: 3 },
  ],
  [
    'validate_confluence_content',
    handleValidateConfluenceContent as unknown as jest.Mock,
    { content: '<p>x</p>' },
  ],
  [
    'move_confluence_page',
    handleMoveConfluencePage as unknown as jest.Mock,
    { pageId: '2', targetParentId: '3' },
  ],
  ['search_confluence_pages', handleSearchConfluencePages as unknown as jest.Mock, { cql: 'x' }],
  ['get_confluence_labels', handleGetConfluenceLabels as unknown as jest.Mock, { pageId: '2' }],
  [
    'add_confluence_label',
    handleAddConfluenceLabel as unknown as jest.Mock,
    { pageId: '2', label: 'l' },
  ],
  [
    'remove_confluence_label',
    handleRemoveConfluenceLabel as unknown as jest.Mock,
    { pageId: '2', label: 'l' },
  ],
];

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createConfluenceServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createConfluenceServer', () => {
  let consoleError: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    // `server.onerror` logs; a protocol-level error test would otherwise print a stack.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns a distinct Server instance on each call', () => {
    const a = createConfluenceServer();
    const b = createConfluenceServer();
    expect(a).not.toBe(b);
  });

  it('installs an onerror hook rather than leaving transport errors unobserved', () => {
    const server = createConfluenceServer();
    expect(typeof server.onerror).toBe('function');
    server.onerror!(new Error('boom'));
    expect(consoleError).toHaveBeenCalledWith('[MCP Error]', expect.any(Error));
  });

  it('completes an initialize handshake over a real transport', async () => {
    const { client, close } = await connectedClient();
    try {
      const info = client.getServerVersion();
      expect(info).toMatchObject({ name: 'confluence-cloud' });
      expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    } finally {
      await close();
    }
  });
});

describe('tools/list', () => {
  let client: Client;
  let close: () => Promise<void>;
  let tools: Array<{ name: string; description?: string; inputSchema: any }>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ({ client, close } = await connectedClient());
    tools = (await client.listTools()).tools as typeof tools;
  });

  afterEach(async () => {
    await close();
  });

  it('advertises exactly the tools declared in toolSchemas', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(toolSchemas).sort());
  });

  it('advertises 17 tools', () => {
    expect(tools).toHaveLength(17);
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
    }
  });

  it('gives every tool a well-formed object inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  it('never lists a required field that is not among the declared properties', () => {
    for (const tool of tools) {
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(required);
      }
    }
  });

  it('omits `required` for tools whose schema declares none', () => {
    const instances = tools.find((t) => t.name === 'list_confluence_instances')!;
    expect(instances.inputSchema).not.toHaveProperty('required');
  });

  it('carries `required` through for tools whose schema declares it', () => {
    const getPage = tools.find((t) => t.name === 'get_confluence_page')!;
    expect(getPage.inputSchema.required).toEqual(
      (toolSchemas.get_confluence_page.inputSchema as { required: string[] }).required
    );
  });
});

describe('tools/call dispatch', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.clearAllMocks();
    ({ client, close } = await connectedClient());
  });

  afterEach(async () => {
    await close();
  });

  it('has a routing table covering every advertised tool', () => {
    expect(ROUTES.map(([name]) => name).sort()).toEqual(Object.keys(toolSchemas).sort());
  });

  it.each(ROUTES.map(([name, , args]) => [name, args] as const))(
    'routes %s to its own handler and nothing else',
    async (name, args) => {
      const result = await client.callTool({ name, arguments: args });

      expect(result.content).toEqual([{ type: 'text', text: `handled:${name}` }]);

      for (const [otherName, fn] of ROUTES) {
        if (otherName === name) {
          expect(fn).toHaveBeenCalledTimes(1);
        } else {
          expect(fn).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('forwards the caller arguments verbatim to the handler', async () => {
    await client.callTool({
      name: 'get_confluence_page',
      arguments: { pageId: '15106417', format: 'storage' },
    });
    expect(handleGetConfluencePage).toHaveBeenCalledWith({
      pageId: '15106417',
      format: 'storage',
    });
  });

  it('substitutes {} when a tool is called with no arguments', async () => {
    await client.callTool({ name: 'list_confluence_spaces' });
    expect(handleListConfluenceSpaces).toHaveBeenCalledWith({});
  });

  it('calls the instance handler with no arguments at all', async () => {
    await client.callTool({ name: 'list_confluence_instances', arguments: {} });
    expect(handleListConfluenceInstances).toHaveBeenCalledWith();
  });

  it('rejects an unknown tool name with MethodNotFound', async () => {
    await expect(
      client.callTool({ name: 'delete_confluence_everything', arguments: {} })
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
      message: expect.stringContaining('Unknown tool: delete_confluence_everything'),
    });
  });

  it('wraps a plain handler exception as InternalError without leaking a stack', async () => {
    handleGetConfluencePage.mockRejectedValueOnce(new Error('axios exploded') as never);
    await expect(
      client.callTool({ name: 'get_confluence_page', arguments: { pageId: '1' } })
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('Internal server error: axios exploded'),
    });
  });

  it('stringifies a non-Error rejection rather than reporting [object Object]', async () => {
    handleGetConfluencePage.mockRejectedValueOnce('just a string' as never);
    await expect(
      client.callTool({ name: 'get_confluence_page', arguments: { pageId: '1' } })
    ).rejects.toMatchObject({
      message: expect.stringContaining('Internal server error: just a string'),
    });
  });

  it('passes an McpError from a handler through unchanged', async () => {
    handleUpdateConfluencePage.mockRejectedValueOnce(
      new McpError(ErrorCode.InvalidParams, 'expectedVersion is required') as never
    );
    await expect(
      client.callTool({ name: 'update_confluence_page', arguments: { pageId: '1' } })
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('expectedVersion is required'),
    });
  });
});

describe('resource endpoints', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ({ client, close } = await connectedClient());
  });

  afterEach(async () => {
    await close();
  });

  it('advertises no resources', async () => {
    await expect(client.listResources()).resolves.toEqual({ resources: [] });
  });

  it('advertises no resource templates', async () => {
    await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
  });

  it('rejects a resource read with InvalidRequest naming the uri', async () => {
    await expect(client.readResource({ uri: 'confluence://page/1' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('confluence://page/1'),
    });
  });
});
