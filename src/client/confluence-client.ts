import axios, { AxiosInstance } from 'axios';
import { ConfluenceError } from '../types/index.js';
import type { 
  ConfluenceConfig, 
  Space, 
  Page, 
  Label, 
  SearchResult, 
  PaginatedResponse,
  SimplifiedPage
} from '../types/index.js';

export class ConfluenceClient {
  private v2Client: AxiosInstance;
  private v1Client: AxiosInstance;
  private domain: string;
  private baseURL: string;
  private v2Path: string;

  constructor(config: ConfluenceConfig) {
    this.domain = config.domain;
    this.baseURL = `https://${config.domain}/wiki`;
    this.v2Path = '/api/v2';
    const v1Path = '/rest/api';
    
    // V2 API client for most operations
    this.v2Client = axios.create({
      baseURL: this.baseURL + this.v2Path,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
        'X-Atlassian-Token': 'no-check'
      }
    });

    // V1 API client specifically for content
    this.v1Client = axios.create({
      baseURL: this.baseURL + v1Path,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
        'X-Atlassian-Token': 'no-check'
      }
    });

    // Log configuration for debugging
    console.error('Confluence client configured with domain:', config.domain);
  }

  // Verify the connection to Confluence API
  async verifyConnection(): Promise<void> {
    try {
      await this.v2Client.get('/spaces', { params: { limit: 1 } });
      console.error('Successfully connected to Confluence API');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Log only serializable error details
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message
        };
        console.error('Failed to connect to Confluence API:', errorDetails);
      }
      throw new Error('Failed to connect to Confluence API');
    }
  }

  // Space operations
  async getConfluenceSpaces(limit = 25, start = 0): Promise<PaginatedResponse<Space>> {
    const response = await this.v2Client.get('/spaces', {
      params: { limit, start }
    });
    return response.data;
  }

  async getConfluenceSpace(spaceId: string): Promise<Space> {
    const response = await this.v2Client.get(`/spaces/${spaceId}`);
    return response.data;
  }

  // Page operations
  async getConfluencePages(spaceId: string, limit = 25, start = 0, title?: string): Promise<PaginatedResponse<Page>> {
    const response = await this.v2Client.get('/pages', {
      params: {
        spaceId,
        limit,
        start,
        status: 'current',
        ...(title && { title })
      }
    });
    return response.data;
  }

  async searchPageByName(title: string, spaceId?: string): Promise<Page[]> {
    try {
      const params: any = {
        title,
        status: 'current',
        limit: 10 // Reasonable limit for multiple matches
      };
      
      if (spaceId) {
        params.spaceId = spaceId;
      }

      const response = await this.v2Client.get('/pages', { params });
      return response.data.results;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Error searching for page:', error.message);
        throw new ConfluenceError(
          `Failed to search for page: ${error.message}`,
          'UNKNOWN'
        );
      }
      throw error;
    }
  }

  async getPageContent(pageId: string): Promise<string> {
    try {
      console.error(`Fetching content for page ${pageId} using v1 API`);
      
      // Use v1 API to get content, which reliably returns body content
      const response = await this.v1Client.get(`/content/${pageId}`, {
        params: {
          expand: 'body.storage'
        }
      });
      
      const content = response.data.body?.storage?.value;
      
      if (!content) {
        throw new ConfluenceError(
          'Page content is empty or not accessible',
          'EMPTY_CONTENT'
        );
      }

      return content;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new ConfluenceError(
            'Page content not found',
            'PAGE_NOT_FOUND'
          );
        }
        if (error.response?.status === 403) {
          throw new ConfluenceError(
            'Insufficient permissions to access page content',
            'INSUFFICIENT_PERMISSIONS'
          );
        }
        throw new ConfluenceError(
          `Failed to get page content: ${error.message}`,
          'UNKNOWN'
        );
      }
      throw error;
    }
  }

  async getConfluencePage(pageId: string): Promise<Page> {
    try {
      // Get page metadata
      const pageResponse = await this.v2Client.get(`/pages/${pageId}`);
      const page = pageResponse.data;

      try {
        // Get page content
        const content = await this.getPageContent(pageId);
        return {
          ...page,
          body: {
            storage: {
              value: content,
              representation: 'storage'
            }
          }
        };
      } catch (contentError) {
        if (contentError instanceof ConfluenceError && 
            contentError.code === 'EMPTY_CONTENT') {
          return page; // Return metadata only for empty pages
        }
        throw contentError;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Error fetching page:', error.message);
        throw error;
      }
      console.error('Error fetching page:', error instanceof Error ? error.message : 'Unknown error');
      throw new Error('Failed to fetch page content');
    }
  }

  // Removing duplicate method since it's redundant with getConfluencePage

  async createConfluencePage(spaceId: string, title: string, content: string, parentId?: string): Promise<Page> {
    const body = {
      spaceId,
      status: 'current',
      title,
      body: {
        representation: 'storage',
        value: content
      },
      ...(parentId && { parentId })
    };

    const response = await this.v2Client.post('/pages', body);
    return response.data;
  }

  async updateConfluencePage(pageId: string, title: string, content: string, version: number): Promise<Page> {
    const body = {
      id: pageId,
      status: 'current',
      title,
      body: {
        representation: 'storage',
        value: content
      },
      version: {
        number: version + 1,
        message: `Updated via MCP at ${new Date().toISOString()}`
      }
    };

    const response = await this.v2Client.put(`/pages/${pageId}`, body);
    return response.data;
  }

  // Search operations
  async searchConfluenceContent(query: string, limit = 25, start = 0): Promise<SearchResult> {
    try {
      console.error('Searching Confluence with CQL:', query);
      
      // Use the v1 search endpoint with CQL
      const response = await this.v1Client.get('/search', {
        params: {
          cql: query.includes('type =') ? query : `text ~ "${query}"`,
          limit,
          start,
          expand: 'content.space,content.version,content.body.view.value'
        }
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
            _links: result.content._links
          },
          url: `https://${this.domain}/wiki${result.content._links?.webui || ''}`,
          lastModified: result.content.version?.when,
          excerpt: result.excerpt || ''
        })),
        _links: {
          next: response.data._links?.next,
          base: this.baseURL + '/rest/api'
        }
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Error searching content:', error.message, error.response?.data);
        throw new ConfluenceError(
          `Failed to search content: ${error.message}`,
          'SEARCH_FAILED'
        );
      }
      throw error;
    }
  }

  // Labels operations
  async getConfluenceLabels(pageId: string): Promise<PaginatedResponse<Label>> {
    const response = await this.v2Client.get(`/pages/${pageId}/labels`);
    return response.data;
  }

  async addConfluenceLabel(pageId: string, label: string): Promise<Label> {
    try {
      const response = await this.v2Client.post(`/pages/${pageId}/labels`, {
        name: label
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
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
            throw new ConfluenceError(
              'Page not found',
              'PAGE_NOT_FOUND'
            );
          case 409:
            throw new ConfluenceError(
              'Label already exists on this page',
              'LABEL_EXISTS'
            );
          default:
            console.error('Error adding label:', error.response?.data);
            throw new ConfluenceError(
              `Failed to add label: ${error.message}`,
              'UNKNOWN'
            );
        }
      }
      throw error;
    }
  }

  async removeConfluenceLabel(pageId: string, label: string): Promise<void> {
    try {
      await this.v2Client.delete(`/pages/${pageId}/labels/${label}`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        switch (error.response?.status) {
          case 403:
            throw new ConfluenceError(
              'Insufficient permissions to remove labels',
              'PERMISSION_DENIED'
            );
          case 404:
            throw new ConfluenceError(
              'Page or label not found',
              'PAGE_NOT_FOUND'
            );
          default:
            console.error('Error removing label:', error.response?.data);
            throw new ConfluenceError(
              `Failed to remove label: ${error.message}`,
              'UNKNOWN'
            );
        }
      }
      throw error;
    }
  }
}
