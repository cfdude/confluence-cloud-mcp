import axios from 'axios';
export class ConfluenceClient {
    client;
    domain;
    constructor(config) {
        this.domain = config.domain;
        this.client = axios.create({
            baseURL: `https://${config.domain}/wiki/api/v2`,
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
    async getSpaces(limit = 25, start = 0) {
        const response = await this.client.get('/spaces', {
            params: { limit, start }
        });
        return response.data;
    }
    async getSpace(spaceId) {
        const response = await this.client.get(`/spaces/${spaceId}`);
        return response.data;
    }
    // Page operations
    async getPages(spaceId, limit = 25, start = 0, title) {
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
    async getPage(pageId) {
        const response = await this.client.get(`/pages/${pageId}`);
        return response.data;
    }
    async getPageContent(pageId) {
        const response = await this.client.get(`/pages/${pageId}/body`, {
            params: {
                body_format: 'storage'
            }
        });
        return response.data;
    }
    async createPage(spaceId, title, content, parentId) {
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
    async updatePage(pageId, title, content, version) {
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
    async searchContent(query, limit = 25, start = 0) {
        const response = await this.client.get('/pages', {
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
    async getLabels(pageId) {
        const response = await this.client.get(`/pages/${pageId}/labels`);
        return response.data;
    }
    async addLabel(pageId, label) {
        const response = await this.client.post(`/pages/${pageId}/labels`, {
            name: label
        });
        return response.data;
    }
    async removeLabel(pageId, label) {
        await this.client.delete(`/pages/${pageId}/labels/${label}`);
    }
}
