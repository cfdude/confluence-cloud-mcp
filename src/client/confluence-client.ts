import axios, {
  AxiosInstance,
  AxiosError,
  RawAxiosResponseHeaders,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
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
import { ConfluenceApiError, ConfluenceError } from '../types/index.js';

/**
 * 429 retry budget for the v2 client.
 *
 * The interceptor re-issues a rate-limited request, and the retry re-enters the interceptor,
 * so without a budget a server stuck on 429 keeps the MCP call alive forever -- the agent
 * waits on a tool that will never answer. Three retries and a 30s ceiling bound the worst
 * case at roughly a minute and a half before a clear, terminal error.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Confluence's reset header can already be in the past; never hot-loop on it. */
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
/** A far-future reset header must not park the call for hours. */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/** The v2 request config, carrying the retry counter across re-issues. */
type RateLimitedRequestConfig = InternalAxiosRequestConfig & { __rateLimitRetries?: number };

/** What a failed HTTP call tells us, normalised across both clients. */
interface HttpFailure {
  /** Undefined when the request never got a response at all (DNS, socket, adapter). */
  status?: number;
  message: string;
  data?: unknown;
}

/**
 * Describe a caught error as an HTTP failure -- or `undefined` if it is not one.
 *
 * ASK THIS, NEVER `isAxiosError`, inside a method's catch block. The v2 client's response
 * interceptor ends `throw this.handleError(error)`, which replaces the AxiosError with a
 * ConfluenceApiError before any method's catch runs, so `isAxiosError(error)` is FALSE for
 * every v2 failure. Every branch that used to sit behind that question -- the documented v1
 * fallbacks, the status-specific messages, the whole ConfluenceError code mapping -- was
 * therefore dead code, and errors like "that label already exists" reached the agent as an
 * opaque InternalError. The v1 client has no interceptor and still raises a real AxiosError,
 * which is why the identical pattern kept working there. This handles both.
 *
 * Returns `undefined` for a ConfluenceError we raised ourselves and for anything else, so a
 * caller can rethrow it untouched rather than re-wrapping a code it already computed.
 *
 * A v2 call that never reached Confluence at all (socket hang-up, DNS, a broken adapter) also
 * arrives here as a ConfluenceApiError, but with NO status. Gate status-code mapping on
 * `status !== undefined`, not on this function returning something: running a statusless
 * failure through a `switch` would label a dropped connection INVALID_LABEL -- a confident,
 * wrong diagnosis. No status means rethrow what we were given.
 */
function httpFailure(error: unknown): HttpFailure | undefined {
  if (isAxiosError(error)) {
    return {
      status: error.response?.status,
      message: error.message,
      data: error.response?.data,
    };
  }
  if (error instanceof ConfluenceApiError) {
    return { status: error.status, message: error.message, data: error.responseData };
  }
  return undefined;
}

/** Plain-language diagnosis of a failed page READ, so the agent can pick a next move. */
function describePageReadFailure(pageId: string, status: number): string {
  if (status === 404) return `Page ${pageId} not found`;
  if (status === 403) return `Insufficient permissions to read page ${pageId}`;
  if (status === 401) return `Authentication failed while reading page ${pageId}`;
  if (status >= 500) return `Confluence server error while reading page ${pageId}`;
  return `Failed to fetch page ${pageId}`;
}

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

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': config.userAgent || 'Confluence-Cloud-MCP/2.0',
    };

    // OAuth2 is carried as a Bearer header; basic auth uses axios's `auth` option.
    //
    // These were previously conflated: `auth` was hardcoded to `{username: email, password:
    // apiToken}` regardless of `auth.type`, so for an oauth2 config BOTH were undefined and
    // the request went out with no credentials at all. The access token never reached
    // Confluence, which answered 401 -- surfaced as a bare "Failed to connect to Confluence
    // API" with nothing pointing at the cause. The only code that built a Bearer header lived
    // in utils/confluence-api.ts, which nothing imports.
    const isOAuth2 = config.auth.type === 'oauth2';

    if (isOAuth2) {
      if (!config.auth.accessToken) {
        throw new Error(
          'OAuth2 authentication requires an access token. Set CONFLUENCE_OAUTH_ACCESS_TOKEN, ' +
            'or use basic auth with CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN.'
        );
      }
      headers.Authorization = `Bearer ${config.auth.accessToken}`;
    } else if (!config.auth.email || !config.auth.apiToken) {
      throw new Error(
        'Basic authentication requires both an email and an API token. Set CONFLUENCE_EMAIL ' +
          'and CONFLUENCE_API_TOKEN, or use OAuth2 with CONFLUENCE_OAUTH_ACCESS_TOKEN.'
      );
    }

    /** Omitted entirely for OAuth2 -- an empty `auth` object would strip the Bearer header. */
    const basicAuth = isOAuth2
      ? undefined
      : { username: config.auth.email as string, password: config.auth.apiToken as string };

    // Configure for v2 API with domain in URL
    const axiosConfig: any = {
      baseURL: `https://${config.domain}/wiki/api/v2`,
      headers,
      ...(basicAuth ? { auth: basicAuth } : {}),
    };

    // Configure v1 client for search and labels
    const axiosConfigV1: any = {
      baseURL: `https://${config.domain}/wiki/rest/api`,
      headers: {
        ...headers,
        'X-Atlassian-Token': 'no-check',
      },
      ...(basicAuth ? { auth: basicAuth } : {}),
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
          const config = error.config as RateLimitedRequestConfig | undefined;
          const retriesSoFar = config?.__rateLimitRetries ?? 0;

          if (!config || retriesSoFar >= MAX_RATE_LIMIT_RETRIES) {
            throw new ConfluenceApiError(
              `Confluence API rate limit exceeded: gave up after ${MAX_RATE_LIMIT_RETRIES} ` +
                `retries. Retry later, or reduce the request rate.`,
              429,
              error.response.data
            );
          }

          const resetTime = parseInt(
            String(error.response.headers['x-ratelimit-reset'] || '0'),
            10
          );
          const waitTime = Math.min(
            Math.max(resetTime - Date.now(), MIN_RATE_LIMIT_WAIT_MS),
            MAX_RATE_LIMIT_WAIT_MS
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          // The counter rides on the re-issued config so it survives re-entering this same
          // interceptor -- that, not a closure variable, is what bounds a retry LOOP.
          const retryConfig: RateLimitedRequestConfig = {
            ...config,
            __rateLimitRetries: retriesSoFar + 1,
          };
          return this.client.request(retryConfig);
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

    // The status is PRESERVED (not flattened into the message): design.md D12 needs it to
    // classify a version conflict, and a message-only heuristic is not good enough for a
    // write path.
    if (error.response?.data) {
      const confluenceError = error.response.data as ConfluenceError;
      return new ConfluenceApiError(
        `Confluence API Error: ${confluenceError.message || JSON.stringify(error.response.data)}`,
        error.response.status,
        error.response.data
      );
    }
    return new ConfluenceApiError(`Confluence API Error: ${error.message}`, error.response?.status);
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

      const failure = httpFailure(error);
      if (failure?.status !== undefined) {
        // Provide specific error messages based on status code
        if (failure.status === 401) {
          errorMessage = 'Authentication failed: Invalid API token or email';
        } else if (failure.status === 403) {
          errorMessage = 'Authorization failed: Insufficient permissions';
        } else if (failure.status === 404) {
          errorMessage = 'API endpoint not found: Check Confluence domain';
        } else if (failure.status >= 500) {
          errorMessage = 'Confluence server error: API may be temporarily unavailable';
        }

        console.error(`${errorMessage}:`, { status: failure.status, message: failure.message });
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
        'created-date' | '-created-date' | 'modified-date' | '-modified-date' | 'title' | '-title';
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
      const failure = httpFailure(error);
      if (failure?.status !== undefined) {
        console.error('Error searching for page:', failure.message);
        throw new ConfluenceError(`Failed to search for page: ${failure.message}`, 'UNKNOWN');
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
      const failure = httpFailure(error);
      if (failure) {
        if (failure.status === 404) {
          throw new ConfluenceError('Page content not found', 'PAGE_NOT_FOUND');
        }
        if (failure.status === 403) {
          throw new ConfluenceError(
            'Insufficient permissions to access page content',
            'INSUFFICIENT_PERMISSIONS'
          );
        }
        throw new ConfluenceError(`Failed to get page content: ${failure.message}`, 'UNKNOWN');
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
      console.error(
        'Error fetching page:',
        error instanceof Error ? error.message : 'Unknown error'
      );

      // A ConfluenceError from the v1 body fallback already carries a precise code
      // (PAGE_NOT_FOUND, INSUFFICIENT_PERMISSIONS). Re-wrapping it discarded that.
      if (error instanceof ConfluenceError) {
        throw error;
      }

      const failure = httpFailure(error);
      if (failure?.status !== undefined) {
        // Say WHICH failure it was. The old catch collapsed 404, 403 and 500 alike into a
        // bare "Failed to fetch page content", so an agent could not tell "no such page"
        // from "no permission" and had no basis for choosing what to do next. The status
        // stays on the error as well, so nothing downstream loses the ability to classify.
        throw new ConfluenceApiError(
          `${describePageReadFailure(pageId, failure.status)} (HTTP ${failure.status}): ` +
            failure.message,
          failure.status,
          failure.data
        );
      }

      throw error;
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

  /**
   * Replace a page's body.
   *
   * `nextVersion` is the version number to SUBMIT, already incremented. This method does no
   * arithmetic on it and never derives it from a caller-supplied value: version resolution
   * belongs to the write-safety layer (design.md D5), which reads the page's current version
   * immediately beforehand. The previous signature forwarded a caller-supplied `version`
   * verbatim while the tool description told the agent to increment it -- an off-by-one that
   * surfaced as an undiagnosable 409.
   */
  async updateConfluencePage(
    pageId: string,
    title: string,
    content: string,
    nextVersion: number
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
        number: nextVersion,
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
      let failure = httpFailure(error);

      // Fall back to V1 when the deployment has no v2 label route.
      //
      // The body is an ARRAY of label objects. It was a single object here, which never
      // showed up because the fallback was unreachable; the moment it became reachable it
      // would have 400'd on first use. Atlassian's v1 reference for
      // `POST /rest/api/content/{id}/label` documents the body as the list of labels to add:
      // https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-labels/
      if (failure?.status === 404) {
        try {
          const response = await this.clientV1.post(`/content/${pageId}/label`, [
            { prefix, name: label },
          ]);
          return response.data;
        } catch (fallbackError) {
          // Diagnose the FALLBACK's failure -- reporting the v2 404 would blame the wrong
          // request now that the fallback actually runs.
          failure = httpFailure(fallbackError);
          if (!failure) throw fallbackError;
        }
      }

      if (failure?.status !== undefined) {
        switch (failure.status) {
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
            console.error('Error adding label:', failure.data);
            throw new ConfluenceError(`Failed to add label: ${failure.message}`, 'UNKNOWN');
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
      let failure = httpFailure(error);

      // Fall back to V1 when the deployment has no v2 label route.
      if (failure?.status === 404) {
        try {
          await this.clientV1.delete(`/content/${pageId}/label/${label}`);
          return;
        } catch (fallbackError) {
          failure = httpFailure(fallbackError);
          if (!failure) throw fallbackError;
        }
      }

      if (failure?.status !== undefined) {
        switch (failure.status) {
          case 403:
            throw new ConfluenceError(
              'Insufficient permissions to remove labels',
              'PERMISSION_DENIED'
            );
          case 404:
            throw new ConfluenceError('Page or label not found', 'PAGE_NOT_FOUND');
          default:
            console.error('Error removing label:', failure.data);
            throw new ConfluenceError(`Failed to remove label: ${failure.message}`, 'UNKNOWN');
        }
      }
      throw error;
    }
  }

  // Search operations
  async searchConfluenceContent(
    cql: string,
    options: {
      limit?: number;
      start?: number;
      plainText?: boolean;
    } = {}
  ): Promise<ConfluenceSearchResult> {
    try {
      const isPlainText = options.plainText === true;
      const escapedText = cql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const cqlQuery = isPlainText ? `text ~ "${escapedText}"` : cql;

      console.error('Searching Confluence with CQL:', cqlQuery);

      // Use the v1 search endpoint with CQL
      const response = await this.clientV1.get('/search', {
        params: {
          cql: cqlQuery,
          limit: options.limit ?? 25,
          start: options.start ?? 0,
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
        start: response.data.start ?? 0,
        limit: response.data.limit ?? 25,
        size: response.data.size ?? 0,
        _links: {
          next: response.data._links?.next,
          self: response.data._links?.self || '',
        },
      };
    } catch (error) {
      const failure = httpFailure(error);
      if (failure) {
        console.error('Error searching content:', failure.message, failure.data);
        throw new ConfluenceError(`Failed to search content: ${failure.message}`, 'SEARCH_FAILED');
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

  // Content property operations
  async setContentProperty(pageId: string, key: string, value: any): Promise<void> {
    try {
      // Try V2 API first (if available)
      await this.client.put(`/pages/${pageId}/properties/${key}`, {
        key,
        value,
      });
    } catch (error) {
      let failure = httpFailure(error);

      // Fall back to V1 when the deployment has no v2 property route.
      if (failure?.status === 404) {
        try {
          await this.clientV1.put(`/content/${pageId}/property/${key}`, {
            key,
            value,
          });
          return;
        } catch (fallbackError) {
          failure = httpFailure(fallbackError);
          if (!failure) throw fallbackError;
        }
      }

      if (failure?.status !== undefined) {
        console.error('Error setting content property:', failure.data);
        throw new ConfluenceError(
          `Failed to set content property: ${failure.message}`,
          'PROPERTY_SET_FAILED'
        );
      }
      throw error;
    }
  }

  // Move page to a new location
  async moveConfluencePage(
    pageId: string,
    targetParentId: string,
    position: 'append' | 'before' | 'after' = 'append'
  ): Promise<void> {
    try {
      // Use V1 API for move operation as it's the documented approach
      await this.clientV1.put(
        `/content/${pageId}/move/${position}/${targetParentId}`,
        {},
        {
          headers: {
            'Atl-Confluence-With-Admin-Key': true,
          },
        }
      );
    } catch (error) {
      const failure = httpFailure(error);
      if (failure) {
        console.error('Error moving page:', failure.data);

        switch (failure.status) {
          case 404:
            throw new ConfluenceError(
              `Page ${pageId} or target parent ${targetParentId} not found`,
              'PAGE_NOT_FOUND'
            );
          case 403:
            throw new ConfluenceError(
              'Insufficient permissions to move this page',
              'ACCESS_DENIED'
            );
          case 400:
            throw new ConfluenceError(
              `Invalid move operation: ${
                (failure.data as { message?: string } | undefined)?.message || failure.message
              }`,
              'INVALID_REQUEST'
            );
          default:
            throw new ConfluenceError(`Failed to move page: ${failure.message}`, 'MOVE_FAILED');
        }
      }
      throw error;
    }
  }

  // Get rate limit information
  getRateLimitInfo(): RateLimitInfo {
    return { ...this.rateLimitInfo };
  }
}
