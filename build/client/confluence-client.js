import axios from 'axios';
import { ConfluenceError } from '../types/index.js';
export class ConfluenceClient {
    v2Client;
    v1Client;
    domain;
    constructor(config) {
        this.domain = config.domain;
        const baseURL = `https://${config.domain}`;
        const v2Path = '/wiki/api/v2';
        const v1Path = '/wiki/rest/api';
        // V2 API client for most operations
        this.v2Client = axios.create({
            baseURL: baseURL + v2Path,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
                'X-Atlassian-Token': 'no-check'
            }
        });
        // V1 API client specifically for content
        this.v1Client = axios.create({
            baseURL: baseURL + v1Path,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
                'X-Atlassian-Token': 'no-check'
            }
        });
        // Log configuration for debugging
        console.log('Confluence client configured:', {
            baseURL,
            v1Path,
            v2Path,
            email: config.email,
            hasToken: !!config.apiToken,
            v2Headers: this.v2Client.defaults.headers,
            v1Headers: this.v1Client.defaults.headers
        });
    }
    // Verify the connection to Confluence API
    async verifyConnection() {
        try {
            await this.v2Client.get('/spaces', { params: { limit: 1 } });
            console.log('Successfully connected to Confluence API');
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Failed to connect to Confluence API:', {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data,
                    headers: error.response?.headers
                });
            }
            throw error;
        }
    }
    // Space operations
    async getConfluenceSpaces(limit = 25, start = 0) {
        const response = await this.v2Client.get('/spaces', {
            params: { limit, start }
        });
        return response.data;
    }
    async getConfluenceSpace(spaceId) {
        const response = await this.v2Client.get(`/spaces/${spaceId}`);
        return response.data;
    }
    // Page operations
    async getConfluencePages(spaceId, limit = 25, start = 0, title) {
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
    async searchPageByName(title, spaceId) {
        try {
            const params = {
                title,
                status: 'current',
                limit: 10 // Reasonable limit for multiple matches
            };
            if (spaceId) {
                params.spaceId = spaceId;
            }
            const response = await this.v2Client.get('/pages', { params });
            return response.data.results;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error searching for page:', error.response?.data || error.message);
                throw new ConfluenceError(`Failed to search for page: ${error.message}`, 'UNKNOWN');
            }
            throw error;
        }
    }
    async getPageContent(pageId) {
        try {
            console.log(`Fetching content for page ${pageId} using v1 API`);
            // Use v1 API to get content, which reliably returns body content
            const response = await this.v1Client.get(`/content/${pageId}`, {
                params: {
                    expand: 'body.storage'
                }
            });
            const content = response.data.body?.storage?.value;
            if (!content) {
                throw new ConfluenceError('Page content is empty or not accessible', 'EMPTY_CONTENT');
            }
            return content;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 404) {
                    throw new ConfluenceError('Page content not found', 'PAGE_NOT_FOUND');
                }
                if (error.response?.status === 403) {
                    throw new ConfluenceError('Insufficient permissions to access page content', 'INSUFFICIENT_PERMISSIONS');
                }
                throw new ConfluenceError(`Failed to get page content: ${error.message}`, 'UNKNOWN');
            }
            throw error;
        }
    }
    async getConfluencePage(pageId) {
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
            }
            catch (contentError) {
                if (contentError instanceof ConfluenceError &&
                    contentError.code === 'EMPTY_CONTENT') {
                    return page; // Return metadata only for empty pages
                }
                throw contentError;
            }
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Error fetching page:', error.response?.data || error.message);
                throw error;
            }
            console.error('Error fetching page:', error);
            throw new Error('Failed to fetch page content');
        }
    }
    // Removing duplicate method since it's redundant with getConfluencePage
    async createConfluencePage(spaceId, title, content, parentId) {
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
    async updateConfluencePage(pageId, title, content, version) {
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
    async searchConfluenceContent(query, limit = 25, start = 0) {
        const response = await this.v2Client.get('/pages', {
            params: {
                title: query,
                limit,
                start,
                status: 'current'
            }
        });
        return {
            results: response.data.results.map((page) => ({
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
    async getConfluenceLabels(pageId) {
        const response = await this.v2Client.get(`/pages/${pageId}/labels`);
        return response.data;
    }
    async addConfluenceLabel(pageId, label) {
        const response = await this.v2Client.post(`/pages/${pageId}/labels`, {
            name: label
        });
        return response.data;
    }
    async removeConfluenceLabel(pageId, label) {
        await this.v2Client.delete(`/pages/${pageId}/labels/${label}`);
    }
}
