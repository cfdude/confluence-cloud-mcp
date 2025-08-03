import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { healthCheckManager } from '../utils/health-check.js';
import { safetyManager, OperationContext } from '../utils/safety-boundaries.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';

// Import the server discovery manager instance (will be created in index.ts)
let serverDiscoveryManager: any = null;

export function setServerDiscoveryManager(manager: any) {
  serverDiscoveryManager = manager;
}

interface LinkToJiraArgs extends ToolArgs {
  pageId: string;
  jiraKey: string;
  linkType: 'documents' | 'implements' | 'tests' | 'references';
  description?: string;
}

export async function handleLinkConfluenceToJira(args: LinkToJiraArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        // Validate safety boundaries
        const context: OperationContext = {
          source: 'confluence',
          operation: 'link_confluence_to_jira',
          timestamp: Date.now(),
        };

        const validation = safetyManager.validateOutgoingOperation('link_to_jira', context);
        if (!validation.allowed) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Operation not allowed: ${validation.reason}`
          );
        }

        // Check if Jira server is available
        if (!serverDiscoveryManager || !serverDiscoveryManager.isAnyServerConnected()) {
          throw new McpError(ErrorCode.InternalError, 'No Jira MCP server available for linking');
        }

        // Get the Confluence page to validate it exists
        const page = await client.getConfluencePage(toolArgs.pageId);
        if (!page) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Confluence page ${toolArgs.pageId} not found`
          );
        }

        // Validate Jira issue exists by calling Jira MCP server
        let jiraIssue;
        try {
          jiraIssue = await serverDiscoveryManager.callJiraTool('get_issue', {
            working_dir: process.cwd(),
            issue_key: toolArgs.jiraKey,
          });
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Jira issue ${toolArgs.jiraKey} not found or inaccessible`
          );
        }

        // Create smart link in Confluence using Content Properties
        const linkData = {
          jiraKey: toolArgs.jiraKey,
          linkType: toolArgs.linkType,
          description: toolArgs.description || `${toolArgs.linkType} ${toolArgs.jiraKey}`,
          createdAt: new Date().toISOString(),
          jiraIssue: {
            summary: jiraIssue.summary || 'Unknown',
            status: jiraIssue.status || 'Unknown',
            assignee: jiraIssue.assignee || 'Unassigned',
          },
        };

        // Store the link in Confluence Content Properties
        await client.setContentProperty(toolArgs.pageId, 'jira-links', linkData);

        // Update page content to include smart link
        const currentContent = page.body?.storage?.value || '';
        const smartLinkHtml = `
          <div class="jira-smart-link" data-jira-key="${toolArgs.jiraKey}">
            <strong>${toolArgs.linkType.toUpperCase()}</strong>: 
            <a href="https://onvex.atlassian.net/browse/${toolArgs.jiraKey}">${toolArgs.jiraKey}</a>
            - ${jiraIssue.summary || 'No summary'}
          </div>
        `;

        const updatedContent = currentContent + smartLinkHtml;

        await client.updateConfluencePage(
          toolArgs.pageId,
          page.title,
          updatedContent,
          page.version.number + 1
        );

        // Record the operation
        safetyManager.recordOperation(context);

        // Try to create reverse link in Jira (if supported)
        try {
          await serverDiscoveryManager.callJiraTool('add_comment', {
            working_dir: process.cwd(),
            issue_key: toolArgs.jiraKey,
            comment: `Documentation: [${page.title}|${page._links?.webui || ''}] (${toolArgs.linkType})`,
          });
        } catch (error) {
          // This is non-fatal
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  success: true,
                  pageId: toolArgs.pageId,
                  pageTitle: page.title,
                  jiraKey: toolArgs.jiraKey,
                  linkType: toolArgs.linkType,
                  message: 'Successfully linked Confluence page to Jira issue',
                  jiraIssue: {
                    summary: jiraIssue.summary,
                    status: jiraIssue.status,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to link to Jira: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface CreateFromJiraArgs extends ToolArgs {
  jiraKey: string;
  templateType?: 'epic-documentation' | 'feature-spec' | 'meeting-notes';
  spaceId: string;
  parentId?: string;
  additionalData?: Record<string, any>;
}

export async function handleCreateConfluenceFromJira(args: CreateFromJiraArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        // Validate safety boundaries
        const context: OperationContext = {
          source: 'confluence',
          operation: 'create_confluence_from_jira',
          timestamp: Date.now(),
        };

        const validation = safetyManager.validateOutgoingOperation('create_from_jira', context);
        if (!validation.allowed) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Operation not allowed: ${validation.reason}`
          );
        }

        // Check if Jira server is available
        if (!serverDiscoveryManager || !serverDiscoveryManager.isAnyServerConnected()) {
          throw new McpError(ErrorCode.InternalError, 'No Jira MCP server available');
        }

        // Get Jira issue data
        let jiraIssue;
        try {
          jiraIssue = await serverDiscoveryManager.callJiraTool('get_issue', {
            working_dir: process.cwd(),
            issue_key: toolArgs.jiraKey,
          });
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Jira issue ${toolArgs.jiraKey} not found: ${error}`
          );
        }

        // Generate content based on template type
        const content = generateTemplateContent(
          toolArgs.templateType || 'epic-documentation',
          jiraIssue,
          toolArgs.additionalData
        );

        const pageTitle = `${jiraIssue.summary || toolArgs.jiraKey} - Documentation`;

        // Create the Confluence page
        const newPage = await client.createConfluencePage(
          toolArgs.spaceId,
          pageTitle,
          content,
          toolArgs.parentId
        );

        // Store the Jira link in page properties
        const linkData = {
          jiraKey: toolArgs.jiraKey,
          linkType: 'documents',
          createdAt: new Date().toISOString(),
          templateType: toolArgs.templateType,
          jiraIssue: {
            summary: jiraIssue.summary,
            status: jiraIssue.status,
            assignee: jiraIssue.assignee,
            description: jiraIssue.description,
          },
        };

        await client.setContentProperty(newPage.id, 'jira-source', linkData);

        // Record the operation
        safetyManager.recordOperation(context);

        // Add comment to Jira issue about the documentation
        try {
          await serverDiscoveryManager.callJiraTool('add_comment', {
            working_dir: process.cwd(),
            issue_key: toolArgs.jiraKey,
            comment: `Documentation created: [${pageTitle}|${newPage._links?.webui || ''}]`,
          });
        } catch (error) {
          // Failed to add Jira comment - continue without blocking
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  success: true,
                  pageId: newPage.id,
                  pageTitle: pageTitle,
                  pageUrl: newPage._links?.webui,
                  jiraKey: toolArgs.jiraKey,
                  templateType: toolArgs.templateType,
                  message: 'Successfully created Confluence page from Jira issue',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create page from Jira: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface JiraHealthCheckArgs extends ToolArgs {
  serverPath?: string;
}

export async function handleJiraHealthCheck(args: JiraHealthCheckArgs) {
  try {
    if (!serverDiscoveryManager) {
      throw new McpError(ErrorCode.InternalError, 'Server discovery manager not initialized');
    }

    const discoveredServers = serverDiscoveryManager.getDiscoveredServers();
    const connectedServers = serverDiscoveryManager.getConnectedServers();

    let targetServerInfo = null;
    if (args.serverPath) {
      const server = serverDiscoveryManager.getServerByPath(args.serverPath);
      if (server && server.client) {
        targetServerInfo = server.client.getServerInfo();
      }
    } else if (connectedServers.length > 0) {
      // Use first connected server
      const server = connectedServers[0];
      if (server.client) {
        targetServerInfo = server.client.getServerInfo();
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              serverDiscoveryEnabled: true,
              discoveredServers: discoveredServers.length,
              connectedServers: connectedServers.length,
              servers: discoveredServers.map((server: any) => ({
                path: server.path,
                serverType: server.serverType,
                version: server.version,
                status: server.status,
                lastAttempt: server.lastAttempt,
                retryCount: server.retryCount,
                availableTools: server.client?.getAvailableTools() || [],
              })),
              targetServerInfo,
              connectionStatus: serverDiscoveryManager.getServerConnectionStatus(),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to check Jira health: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function handleConfluenceHealthCheck() {
  try {
    const healthInfo = healthCheckManager.getHealthInfo();
    const safetyStats = safetyManager.getOperationStats();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...healthInfo,
              uptime: healthCheckManager.getUptime(),
              safetyStats,
              lastUpdated: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get health info: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

interface DiscoverServersArgs extends ToolArgs {
  refresh?: boolean;
}

export async function handleDiscoverJiraServers(args: DiscoverServersArgs) {
  try {
    if (!serverDiscoveryManager) {
      throw new McpError(ErrorCode.InternalError, 'Server discovery manager not initialized');
    }

    if (args.refresh) {
      // Force a discovery refresh
      await serverDiscoveryManager.performDiscovery();
    }

    const discoveredServers = serverDiscoveryManager.getDiscoveredServers();
    const connectionStatus = serverDiscoveryManager.getServerConnectionStatus();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              discoveryEnabled: true,
              serversFound: discoveredServers.length,
              servers: discoveredServers.map((server: any) => ({
                path: server.path,
                serverType: server.serverType,
                version: server.version,
                status: server.status,
                lastAttempt: server.lastAttempt,
                retryCount: server.retryCount,
                availableTools: server.client?.getAvailableTools() || [],
                circuitBreakerState: server.client?.getCircuitBreakerState(),
              })),
              connectionStatus,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to discover servers: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function generateTemplateContent(
  templateType: string,
  jiraIssue: any,
  _additionalData?: Record<string, any>
): string {
  const baseTemplate = `
<h1>${jiraIssue.summary || 'No Title'}</h1>

<div class="jira-info">
  <p><strong>Jira Issue:</strong> <a href="https://onvex.atlassian.net/browse/${jiraIssue.key || 'N/A'}">${jiraIssue.key || 'N/A'}</a></p>
  <p><strong>Status:</strong> ${jiraIssue.status || 'Unknown'}</p>
  <p><strong>Assignee:</strong> ${jiraIssue.assignee || 'Unassigned'}</p>
  <p><strong>Created:</strong> ${new Date().toLocaleDateString()}</p>
</div>

<h2>Description</h2>
<p>${jiraIssue.description || 'No description provided.'}</p>
`;

  switch (templateType) {
    case 'epic-documentation':
      return (
        baseTemplate +
        `
<h2>Epic Overview</h2>
<p>This document provides comprehensive documentation for the epic described above.</p>

<h2>Requirements</h2>
<ul>
  <li>Requirement 1</li>
  <li>Requirement 2</li>
  <li>Requirement 3</li>
</ul>

<h2>Architecture</h2>
<p>Describe the technical architecture and approach.</p>

<h2>Implementation Plan</h2>
<ol>
  <li>Phase 1: Planning and Design</li>
  <li>Phase 2: Core Implementation</li>
  <li>Phase 3: Testing and Validation</li>
  <li>Phase 4: Deployment and Monitoring</li>
</ol>

<h2>Success Criteria</h2>
<ul>
  <li>Criterion 1</li>
  <li>Criterion 2</li>
  <li>Criterion 3</li>
</ul>
`
      );

    case 'feature-spec':
      return (
        baseTemplate +
        `
<h2>Feature Specification</h2>
<p>This document outlines the specifications for the feature described above.</p>

<h2>User Stories</h2>
<ul>
  <li>As a user, I want to...</li>
  <li>As a user, I want to...</li>
</ul>

<h2>Acceptance Criteria</h2>
<ul>
  <li>Given... When... Then...</li>
  <li>Given... When... Then...</li>
</ul>

<h2>Technical Requirements</h2>
<ul>
  <li>Performance requirements</li>
  <li>Security requirements</li>
  <li>Scalability requirements</li>
</ul>

<h2>Dependencies</h2>
<ul>
  <li>Dependency 1</li>
  <li>Dependency 2</li>
</ul>
`
      );

    case 'meeting-notes':
      return (
        baseTemplate +
        `
<h2>Meeting Notes</h2>
<p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
<p><strong>Attendees:</strong> TBD</p>

<h2>Agenda</h2>
<ul>
  <li>Discuss ${jiraIssue.summary}</li>
  <li>Review requirements</li>
  <li>Plan next steps</li>
</ul>

<h2>Discussion</h2>
<p>Meeting discussion notes go here.</p>

<h2>Decisions Made</h2>
<ul>
  <li>Decision 1</li>
  <li>Decision 2</li>
</ul>

<h2>Action Items</h2>
<ul>
  <li>[ ] Action item 1 - Assignee</li>
  <li>[ ] Action item 2 - Assignee</li>
</ul>
`
      );

    default:
      return (
        baseTemplate +
        `
<h2>Additional Information</h2>
<p>This page was automatically generated from Jira issue ${jiraIssue.key || 'N/A'}.</p>
`
      );
  }
}
