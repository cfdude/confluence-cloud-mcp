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
  parentType?: 'page';
  position?: number;
  authorId: string;
  ownerId?: string;
  lastOwnerId?: string | null;
  createdAt: string;
  version: {
    number: number;
    message?: string;
    createdAt: string;
    minorEdit?: boolean;
    authorId?: string;
  };
  body?: {
    storage?: {
      value: string;
      representation: 'storage';
    };
    atlas_doc_format?: any;
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

export interface SimplifiedPage {
  title: string;
  content: string; // markdown
  metadata: {
    id: string;
    spaceId: string;
    version: number;
    lastModified: string;
    url: string;
  };
}

export class ConfluenceError extends Error {
  constructor(
    message: string,
    public readonly code: 'PAGE_NOT_FOUND' | 'MULTIPLE_MATCHES' | 'INSUFFICIENT_PERMISSIONS' | 'EMPTY_CONTENT' | 'UNKNOWN' | 'SEARCH_FAILED'
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
}
