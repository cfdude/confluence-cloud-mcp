export interface ConfluenceConfig {
  domain: string;
  email: string;
  apiToken: string;
}

export interface Space {
  id: string;
  key: string;
  name: string;
  type: 'global' | 'personal';
  status: 'current' | 'archived';
  homepageId?: string;
  description?: string;
  _links: {
    webui: string;
  };
}

export interface Page {
  id: string;
  status: 'current' | 'archived' | 'draft';
  title: string;
  spaceId: string;
  parentId?: string;
  authorId: string;
  createdAt: string;
  version: {
    number: number;
    message?: string;
    createdAt: string;
  };
  body?: {
    storage: {
      value: string;
      representation: 'storage';
    };
  };
  _links: {
    webui: string;
    editui?: string;
    edituiv2?: string;
    tinyui?: string;
  };
}

export interface Label {
  id: string;
  name: string;
  prefix: string;
}

export interface SearchResult {
  results: Array<{
    content: {
      id: string;
      type: 'page' | 'blogpost';
      status: 'current' | 'archived' | 'draft';
      title: string;
      spaceId: string;
      _links: {
        webui: string;
      };
    };
    excerpt?: string;
    url: string;
    lastModified: string;
  }>;
  _links: {
    next?: string;
    base: string;
  };
}

export interface PaginatedResponse<T> {
  results: T[];
  _links: {
    next?: string;
    base: string;
  };
}
