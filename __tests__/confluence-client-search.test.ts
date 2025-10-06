import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const createMock = jest.fn();

jest.mock('axios', () => {
  const actual = jest.requireActual<typeof import('axios')>('axios');
  return {
    __esModule: true,
    default: { create: createMock },
    create: createMock,
    isAxiosError: actual.isAxiosError,
    AxiosError: actual.AxiosError,
  };
});

import { ConfluenceClient } from '../src/client/confluence-client.js';

interface MockAxiosInstance {
  get: jest.Mock;
  post?: jest.Mock;
  put?: jest.Mock;
  delete?: jest.Mock;
  interceptors: {
    response: {
      use: jest.Mock;
    };
  };
  request?: jest.Mock;
}

describe('ConfluenceClient.searchConfluenceContent', () => {
  const baseConfig = {
    domain: 'example.atlassian.net',
    auth: {
      email: 'user@example.com',
      apiToken: 'token',
    },
  } as const;

  const buildAxiosInstance = (): MockAxiosInstance => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    request: jest.fn(),
    interceptors: {
      response: {
        use: jest.fn(),
      },
    },
  });

  beforeEach(() => {
    createMock.mockReset();
  });

  const mockSearchResponse = {
    data: {
      results: [],
      start: 0,
      limit: 25,
      size: 0,
      _links: {},
    },
  };

  function setupClient() {
    const mockV2 = buildAxiosInstance();
    const mockV1 = buildAxiosInstance();
    (mockV1.get as ReturnType<typeof jest.fn>).mockResolvedValue(mockSearchResponse);

    createMock.mockImplementationOnce(() => mockV2);
    createMock.mockImplementationOnce(() => mockV1);

    const client = new ConfluenceClient(baseConfig as any);
    return { client, mockV1 };
  }

  it('passes raw CQL through without modification', async () => {
    const { client, mockV1 } = setupClient();
    const cql = 'space = JO AND text ~ "keyword"';

    await client.searchConfluenceContent(cql);

    expect(mockV1.get).toHaveBeenCalledWith('/search', {
      params: expect.objectContaining({ cql }),
    });
  });

  it('wraps plain text queries when requested', async () => {
    const { client, mockV1 } = setupClient();

    await client.searchConfluenceContent('plain term', { plainText: true });

    expect(mockV1.get).toHaveBeenCalledWith('/search', {
      params: expect.objectContaining({ cql: 'text ~ "plain term"' }),
    });
  });
});
