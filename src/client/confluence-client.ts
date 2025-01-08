import axios, { AxiosInstance } from 'axios';
import type { ConfluenceConfig, Space, Page, Label, SearchResult, PaginatedResponse } from '../types/index.js';

export class ConfluenceClient {
  private client: AxiosInstance;
  private domain: string;

  constructor(config: ConfluenceConfig) {
    this.domain = config.domain;
    this.client = axios.create({
      baseURL: `https://${config.domain}/wiki/rest/api`,
      auth: {
        username: config.email,
        password: config.apiToken
      },
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  // Space operations
  async getSpaces(limit = 25, start = 0): Promise<PaginatedResponse<Space>> {
    const response = await this.client.get('/spaces', {
      params: { limit, start }
    });
    return response.data;
  }

  async getSpace(spaceId: string): Promise<Space> {
    const response = await this.client.get(`/spaces/${spaceId}`);
    return response.data;
  }

  // Page operations
  async getPages(spaceId: string, limit = 25, start = 0, title?: string): Promise<PaginatedResponse<Page>> {
    const response = await this.client.get('/pages', {
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

  async getPage(pageId: string): Promise<Page> {
    const response = await this.client.get(`/content/${pageId}`, {
      params: {
        expand: 'body.storage,version'
      }
    });
    return response.data;
  }

  async getPageContent(pageId: string): Promise<{ value: string; representation: 'storage' }> {
    const response = await this.client.get(`/content/${pageId}`, {
      params: {
        expand: 'body.storage'
      }
    });
    return response.data;
  }

  async createPage(spaceId: string, title: string, content: string, parentId?: string): Promise<Page> {
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

    const response = await this.client.post('/pages', body);
    return response.data;
  }

  async updatePage(pageId: string, title: string, content: string, version: number): Promise<Page> {
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

    const response = await this.client.put(`/pages/${pageId}`, body);
    return response.data;
  }

  // Search operations
  async searchContent(query: string, limit = 25, start = 0): Promise<SearchResult> {
    const response = await this.client.get('/pages', {
      params: {
        title: query,
        limit,
        start,
        status: 'current'
      }
    });
    return {
      results: response.data.results.map((page: Page) => ({
        content: {
          id: page.id,
          type: 'page',
          status: page.status,
          title: page.title,
          spaceId: page.spaceId,
          _links: page._links
        },
        url: page._links.webui,
        lastModified: page.version.createdAt
      })),
      _links: response.data._links
    };
  }

  // Labels operations
  async getLabels(pageId: string): Promise<PaginatedResponse<Label>> {
    const response = await this.client.get(`/pages/${pageId}/labels`);
    return response.data;
  }

  async addLabel(pageId: string, label: string): Promise<Label> {
    const response = await this.client.post(`/pages/${pageId}/labels`, {
      name: label
    });
    return response.data;
  }

  async removeLabel(pageId: string, label: string): Promise<void> {
    await this.client.delete(`/pages/${pageId}/labels/${label}`);
  }
}
