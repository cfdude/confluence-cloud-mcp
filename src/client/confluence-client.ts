import axios, {
  AxiosInstance,
  AxiosError,
  RawAxiosResponseHeaders,
  AxiosResponseHeaders,
  isAxiosError,
} from 'axios';

import type {
  ConfluenceConfig,
  Space,
  Page,
  Label,
  ConfluenceSearchResult,
  PaginatedResponse,
  RateLimitInfo,
  V1SearchResponse,
} from '../types/index.js';
import { ConfluenceError } from '../types/index.js';

export class ConfluenceClient {
  private client: AxiosInstance;
  private clientV1: AxiosInstance;
  private domain: string;
  private baseURL: string;
  private v2Path: string;
  private verified = false;
  private rateLimitInfo: RateLimitInfo = {
    limit: 0,
    remaining: 0,
    resetTime: 0,
  };

  constructor(config: ConfluenceConfig) {
    if (!config.domain) {
      throw new Error('Domain is required');
    }

    this.domain = config.domain;
    this.baseURL = `https://${config.domain}/wiki`;
    this.v2Path = '/api/v2';

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': config.userAgent || 'Confluence-Cloud-MCP/2.0',
    };

    // Configure for v2 API with domain in URL
    const axiosConfig: any = {
      baseURL: `https://${config.domain}/wiki/api/v2`,
      headers,
      auth: {
        username: config.auth.email,
        password: config.auth.apiToken,
      },
    };

    // Configure v1 client for search and labels
    const axiosConfigV1: any = {
      baseURL: `https://${config.domain}/wiki/rest/api`,
      headers: {
        ...headers,
        'X-Atlassian-Token': 'no-check',
      },
      auth: {
        username: config.auth.email,
        password: config.auth.apiToken,
      },
    };

    this.client = axios.create(axiosConfig);
    this.clientV1 = axios.create(axiosConfigV1);

    // Add response interceptor for rate limit handling
    this.client.interceptors.response.use(
      (response) => {
        this.updateRateLimits(response.headers);
        return response;
      },
      async (error: AxiosError) => {
        if (error.response?.status === 429) {
          // Rate limit exceeded
          const resetTime = parseInt(
            String(error.response.headers['x-ratelimit-reset'] || '0'),
            10
          );
          const waitTime = Math.max(resetTime - Date.now(), 1000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          return this.client.request(error.config!);
        }
        throw this.handleError(error);
      }
    );

    // Log configuration for debugging
    console.error('Confluence client configured with domain:', config.domain);
  }

  private updateRateLimits(headers: RawAxiosResponseHeaders | AxiosResponseHeaders): void {
    this.rateLimitInfo = {
      limit: parseInt(String(headers['x-ratelimit-limit'] || '0'), 10),
      remaining: parseInt(String(headers['x-ratelimit-remaining'] || '0'), 10),
      resetTime: parseInt(String(headers['x-ratelimit-reset'] || '0'), 10),
    };
  }

  private handleError(error: AxiosError): Error {
    console.error('Full error response:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      headers: error.response?.headers,
      config: {
        url: error.config?.url,
        method: error.config?.method,
        params: error.config?.params,
      },
    });

    if (error.response?.data) {
      const confluenceError = error.response.data as ConfluenceError;
      return new Error(
        `Confluence API Error: ${confluenceError.message || JSON.stringify(error.response.data)}`
      );
    }
    return new Error(`Confluence API Error: ${error.message}`);
  }

  // Verify connection to Confluence API - throws error if verification fails
  async verifyApiConnection(): Promise<void> {
    try {
      // Make a simple API call that should work with minimal permissions
      await this.client.get('/spaces', { params: { limit: 1 } });
      this.verified = true;
      // Success verification is handled by the caller
    } catch (error) {
      let errorMessage = 'Failed to connect to Confluence API';

      if (isAxiosError(error)) {
        // Extract detailed error information
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
        };

        // Provide specific error messages based on status code
        if (error.response && error.response.status === 401) {
          errorMessage = 'Authentication failed: Invalid API token or email';
        } else if (error.response && error.response.status === 403) {
          errorMessage = 'Authorization failed: Insufficient permissions';
        } else if (error.response && error.response.status === 404) {
          errorMessage = 'API endpoint not found: Check Confluence domain';
        } else if (error.response && error.response.status >= 500) {
          errorMessage = 'Confluence server error: API may be temporarily unavailable';
        }

        console.error(`${errorMessage}:`, errorDetails);
      } else {
        console.error(errorMessage + ':', error instanceof Error ? error.message : String(error));
      }

      // Throw error with detailed message to fail server initialization
      throw new Error(errorMessage);
    }
  }

  // Space operations
  async getConfluenceSpaces(
    options: {
      limit?: number;
      cursor?: string;
      sort?: 'name' | '-name' | 'key' | '-key';
      status?: 'current' | 'archived';
    } = {}
  ): Promise<PaginatedResponse<Space>> {
    if (!this.verified) {
      await this.verifyApiConnection();
    }

    const response = await this.client.get('/spaces', {
      params: {
        limit: options.limit || 25,
        cursor: options.cursor,
        sort: options.sort,
        status: options.status,
        'description-format': 'plain',
      },
    });
    return response.data;
  }

  async getConfluenceSpace(spaceId: string): Promise<Space> {
    const response = await this.client.get(`/spaces/${spaceId}`, {
      params: {
        'description-format': 'plain',
      },
    });
    return response.data;
  }

  // Page operations
  async getConfluencePages(
    spaceId: string,
    options: {
      limit?: number;
      cursor?: string;
      title?: string;
      status?: 'current' | 'archived' | 'draft' | 'trashed';
      sort?:
        | 'created-date'
        | '-created-date'
        | 'modified-date'
        | '-modified-date'
        | 'title'
        | '-title';
    } = {}
  ): Promise<PaginatedResponse<Page>> {
    const response = await this.client.get('/pages', {
      params: {
        'space-id': spaceId,
        limit: options.limit || 25,
        cursor: options.cursor,
        title: options.title,
        status: options.status,
        sort: options.sort,
        'body-format': 'storage',
      },
    });
    return response.data;
  }

  async searchPageByName(title: string, spaceId?: string): Promise<Page[]> {
    try {
      const params: any = {
        title,
        status: 'current',
        limit: 10, // Reasonable limit for multiple matches
      };

      if (spaceId) {
        params['space-id'] = spaceId;
      }

      const response = await this.client.get('/pages', { params });
      return response.data.results;
    } catch (error) {
      if (isAxiosError(error)) {
        console.error('Error searching for page:', error.message);
        throw new ConfluenceError(`Failed to search for page: ${error.message}`, 'UNKNOWN');
      }
      throw error;
    }
  }

  async getPageContent(pageId: string): Promise<string> {
    try {
      console.error(`Fetching content for page ${pageId} using v1 API`);

      // Use v1 API to get content, which reliably returns body content
      const response = await this.clientV1.get(`/content/${pageId}`, {
        params: {
          expand: 'body.storage',
        },
      });

      const content = response.data.body?.storage?.value;

      if (!content) {
        throw new ConfluenceError('Page content is empty or not accessible', 'EMPTY_CONTENT');
      }

      return content;
    } catch (error) {
      if (isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new ConfluenceError('Page content not found', 'PAGE_NOT_FOUND');
        }
        if (error.response?.status === 403) {
          throw new ConfluenceError(
            'Insufficient permissions to access page content',
            'INSUFFICIENT_PERMISSIONS'
          );
        }
        throw new ConfluenceError(`Failed to get page content: ${error.message}`, 'UNKNOWN');
      }
      throw error;
    }
  }

  async getConfluencePage(pageId: string): Promise<Page> {
    try {
      // Get page metadata using v2 API
      const pageResponse = await this.client.get(`/pages/${pageId}`, {
        params: {
          'body-format': 'storage',
        },
      });
      const page = pageResponse.data;

      // If the page already has body content from v2, return it
      if (page.body?.storage?.value) {
        return page;
      }

      try {
        // Otherwise, get page content using v1 API
        const content = await this.getPageContent(pageId);
        return {
          ...page,
          body: {
            storage: {
              value: content,
              representation: 'storage',
            },
          },
        };
      } catch (contentError) {
        if (contentError instanceof ConfluenceError && contentError.code === 'EMPTY_CONTENT') {
          return page; // Return metadata only for empty pages
        }
        throw contentError;
      }
    } catch (error) {
      if (isAxiosError(error)) {
        console.error('Error fetching page:', error.message);
        throw this.handleError(error);
      }
      console.error(
        'Error fetching page:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw new Error('Failed to fetch page content');
    }
  }

  async createConfluencePage(
    spaceId: string,
    title: string,
    content: string,
    parentId?: string
  ): Promise<Page> {
    const body = {
      spaceId,
      status: 'current',
      title,
      parentId,
      body: {
        representation: 'storage',
        value: content,
      },
    };

    const response = await this.client.post('/pages', body);
    return response.data;
  }

  async updateConfluencePage(
    pageId: string,
    title: string,
    content: string,
    version: number
  ): Promise<Page> {
    const body = {
      id: pageId,
      status: 'current',
      title,
      body: {
        representation: 'storage',
        value: content,
      },
      version: {
        number: version,
        message: 'Updated via API',
      },
    };

    const response = await this.client.put(`/pages/${pageId}`, body);
    return response.data;
  }

  async findConfluencePageByTitle(title: string, spaceId?: string): Promise<Page> {
    const pages = await this.searchPageByName(title, spaceId);

    if (pages.length === 0) {
      throw new ConfluenceError(`No page found with title: ${title}`, 'PAGE_NOT_FOUND');
    }

    if (pages.length > 1) {
      throw new ConfluenceError(
        `Multiple pages found with title: ${title}. Please specify a space ID.`,
        'MULTIPLE_MATCHES'
      );
    }

    // Get the full page content
    return this.getConfluencePage(pages[0].id);
  }

  // Label operations
  async getConfluenceLabels(pageId: string): Promise<PaginatedResponse<Label>> {
    const response = await this.client.get(`/pages/${pageId}/labels`);
    return response.data;
  }

  async addConfluenceLabel(pageId: string, label: string, prefix = 'global'): Promise<Label> {
    try {
      // V2 API uses a different endpoint and format
      const response = await this.client.post(`/pages/${pageId}/labels`, {
        name: label,
      });
      return response.data;
    } catch (error) {
      // Fall back to V1 API if V2 fails
      if (isAxiosError(error) && error.response?.status === 404) {
        const response = await this.clientV1.post(`/content/${pageId}/label`, {
          prefix,
          name: label,
        });
        return response.data;
      }

      if (isAxiosError(error)) {
        switch (error.response?.status) {
          case 400:
            throw new ConfluenceError(
              'Invalid label format or label already exists',
              'INVALID_LABEL'
            );
          case 403:
            throw new ConfluenceError(
              'Insufficient permissions to add labels',
              'PERMISSION_DENIED'
            );
          case 404:
            throw new ConfluenceError('Page not found', 'PAGE_NOT_FOUND');
          case 409:
            throw new ConfluenceError('Label already exists on this page', 'LABEL_EXISTS');
          default:
            console.error('Error adding label:', error.response?.data);
            throw new ConfluenceError(`Failed to add label: ${error.message}`, 'UNKNOWN');
        }
      }
      throw error;
    }
  }

  async removeConfluenceLabel(pageId: string, label: string): Promise<void> {
    try {
      // Try V2 API first
      await this.client.delete(`/pages/${pageId}/labels/${label}`);
    } catch (error) {
      // Fall back to V1 API if V2 fails
      if (isAxiosError(error) && error.response?.status === 404) {
        await this.clientV1.delete(`/content/${pageId}/label/${label}`);
        return;
      }

      if (isAxiosError(error)) {
        switch (error.response?.status) {
          case 403:
            throw new ConfluenceError(
              'Insufficient permissions to remove labels',
              'PERMISSION_DENIED'
            );
          case 404:
            throw new ConfluenceError('Page or label not found', 'PAGE_NOT_FOUND');
          default:
            console.error('Error removing label:', error.response?.data);
            throw new ConfluenceError(`Failed to remove label: ${error.message}`, 'UNKNOWN');
        }
      }
      throw error;
    }
  }

  // Search operations
  async searchConfluenceContent(
    query: string,
    options: {
      limit?: number;
      start?: number;
    } = {}
  ): Promise<ConfluenceSearchResult> {
    try {
      console.error('Searching Confluence with CQL:', query);

      // Use the v1 search endpoint with CQL
      const response = await this.clientV1.get('/search', {
        params: {
          cql: query.includes('type =') ? query : `text ~ "${query}"`,
          limit: options.limit || 25,
          start: options.start || 0,
          expand: 'content.space,content.version,content.body.view.value',
        },
      });

      console.error(`Found ${response.data.results?.length || 0} results`);

      return {
        results: (response.data.results || []).map((result: any) => ({
          content: {
            id: result.content.id,
            type: result.content.type,
            status: result.content.status,
            title: result.content.title,
            spaceId: result.content.space?.id,
            _links: result.content._links,
          },
          url: `https://${this.domain}/wiki${result.content._links?.webui || ''}`,
          lastModified: result.content.version?.when,
          excerpt: result.excerpt || '',
        })),
        start: response.data.start || 0,
        limit: response.data.limit || 25,
        size: response.data.size || 0,
        _links: {
          next: response.data._links?.next,
          self: response.data._links?.self || '',
        },
      };
    } catch (error) {
      if (isAxiosError(error)) {
        console.error('Error searching content:', error.message, error.response?.data);
        throw new ConfluenceError(`Failed to search content: ${error.message}`, 'SEARCH_FAILED');
      }
      throw error;
    }
  }

  // V1 Search implementation with CQL support (advanced search)
  async searchContentV1(
    cql: string,
    options: {
      limit?: number;
      start?: number;
    } = {}
  ): Promise<V1SearchResponse> {
    const response = await this.clientV1.get('/search', {
      params: {
        cql,
        limit: options.limit,
        start: options.start,
        expand: 'content.space,content.version',
      },
    });
    return response.data;
  }

  // Content property operations (used for cross-server metadata)
  async setContentProperty(pageId: string, key: string, value: any): Promise<void> {
    try {
      // Try V2 API first (if available)
      await this.client.put(`/pages/${pageId}/properties/${key}`, {
        key,
        value,
      });
    } catch (error) {
      // Fall back to V1 API
      if (isAxiosError(error) && error.response?.status === 404) {
        await this.clientV1.put(`/content/${pageId}/property/${key}`, {
          key,
          value,
        });
        return;
      }

      if (isAxiosError(error)) {
        console.error('Error setting content property:', error.response?.data);
        throw new ConfluenceError(
          `Failed to set content property: ${error.message}`,
          'PROPERTY_SET_FAILED'
        );
      }
      throw error;
    }
  }

  // Get rate limit information
  getRateLimitInfo(): RateLimitInfo {
    return { ...this.rateLimitInfo };
  }
}
