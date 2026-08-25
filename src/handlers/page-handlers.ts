import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { Page } from '../types/index.js';
import { cachePageInstance } from '../utils/instance-cache.js';
import {
  buildPageListEntry,
  buildPageRetrievalPayload,
  resolvePageFormat,
} from '../utils/page-retrieval.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';
import {
  assertExpectedVersion,
  assertWriteIsSafe,
  isVersionConflictResponse,
  resolveWriteVersion,
  versionConflictError,
} from '../utils/write-safety.js';

interface ListPagesArgs extends ToolArgs {
  spaceId: string;
  limit?: number;
  cursor?: string;
  sort?: 'created-date' | '-created-date' | 'modified-date' | '-modified-date' | 'title' | '-title';
  status?: 'current' | 'archived' | 'draft' | 'trashed';
}

export async function handleListConfluencePages(args: ListPagesArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const pages = await client.getConfluencePages(toolArgs.spaceId, {
          limit: toolArgs.limit,
          cursor: toolArgs.cursor,
          sort: toolArgs.sort,
          status: toolArgs.status,
        });

        // Cache page instances for future lookups
        for (const page of pages.results) {
          await cachePageInstance(page.id, toolArgs.spaceId, instanceName);
        }

        // Transform to minimal format with cursor pagination support. Listings carry no
        // page bodies -- see buildPageListEntry (design.md D11, task 4.9).
        const simplified = {
          instance: instanceName,
          spaceId: toolArgs.spaceId,
          results: pages.results.map(buildPageListEntry),
          cursor: pages._links.next?.split('cursor=')[1],
          limit: pages.limit,
          size: pages.size,
          hasMore: !!pages._links.next,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error listing pages:',
          error instanceof Error ? error.message : String(error)
        );
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list pages: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface GetPageArgs extends ToolArgs {
  pageId: string;
  format?: string;
}

export async function handleGetConfluencePage(args: GetPageArgs) {
  // Validated BEFORE the wrapper so an invalid format returns no page content (task 4.3).
  const format = resolvePageFormat(args.format);

  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        const page = await client.getConfluencePage(toolArgs.pageId);

        // Cache the page instance
        await cachePageInstance(page.id, page.spaceId, instanceName);

        const simplified = buildPageRetrievalPayload(page, instanceName, format);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error getting page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface FindPageArgs extends ToolArgs {
  title: string;
  spaceId?: string;
  format?: string;
}

export async function handleFindConfluencePage(args: FindPageArgs) {
  // Same contract as get-by-id, including pre-request validation (design.md D11).
  const format = resolvePageFormat(args.format);

  return withConfluenceContext(
    args,
    { requiresSpace: false },
    async (toolArgs, { client, instanceName }) => {
      try {
        const page = await client.findConfluencePageByTitle(toolArgs.title, toolArgs.spaceId);

        // Cache the page instance
        await cachePageInstance(page.id, page.spaceId, instanceName);

        const simplified = buildPageRetrievalPayload(page, instanceName, format);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(simplified, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error finding page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to find page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface CreatePageArgs extends ToolArgs {
  spaceId: string;
  title: string;
  content: string;
  parentId?: string;
  allowMarkdownContent?: boolean;
}

export async function handleCreateConfluencePage(args: CreatePageArgs) {
  return withConfluenceContext(
    args,
    { requiresSpace: true },
    async (toolArgs, { client, instanceName, spaceConfig }) => {
      // Content checks run BEFORE any request, so a rejected create creates nothing
      // (tasks 5.14, 5.16). Construct-loss is absent by design: there is no prior version to
      // compare against (design.md D11). Deliberately outside the try below -- these errors
      // are the actionable ones and must not be rewrapped as "Failed to create page".
      await assertWriteIsSafe({
        content: toolArgs.content,
        allowMarkdownContent: toolArgs.allowMarkdownContent,
      });

      try {
        // Apply default parent page if configured and not provided
        const parentId = toolArgs.parentId || spaceConfig?.defaultParentPageId;

        const page = await client.createConfluencePage(
          toolArgs.spaceId,
          toolArgs.title,
          toolArgs.content,
          parentId
        );

        // Cache the new page instance
        await cachePageInstance(page.id, toolArgs.spaceId, instanceName);

        // Apply default labels if configured
        if (spaceConfig?.defaultLabels && spaceConfig.defaultLabels.length > 0) {
          for (const label of spaceConfig.defaultLabels) {
            try {
              await client.addConfluenceLabel(page.id, label, 'global');
            } catch (error) {
              console.warn(`Failed to add default label "${label}":`, error);
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Page created successfully',
                  pageId: page.id,
                  title: page.title,
                  spaceId: page.spaceId,
                  version: page.version.number,
                  url: page._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(
          'Error creating page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface UpdatePageArgs extends ToolArgs {
  pageId: string;
  /**
   * Optional (task 5.1). Omitted means "keep the current title".
   *
   * It used to be REQUIRED, which inverted the risk: an agent editing only body content had to
   * restate the title, and any paraphrase silently RENAMED the page.
   */
  title?: string;
  content: string;
  /** Optional optimistic-concurrency check (design.md D5). */
  expectedVersion?: number;
  confirmConstructRemoval?: boolean;
  allowMarkdownContent?: boolean;
  /**
   * Accepted and IGNORED, for callers written against the old schema.
   *
   * NOT mapped onto `expectedVersion`: an old caller was told to send `current + 1`, so
   * treating it as an expectation would turn every legacy call into a spurious conflict. The
   * server resolves the write version itself (design.md D5).
   */
  version?: number;
}

export async function handleUpdateConfluencePage(args: UpdatePageArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      let currentPage: Page | undefined;
      const loadCurrentPage = async (): Promise<Page> => {
        if (currentPage) return currentPage;
        try {
          currentPage = await client.getConfluencePage(toolArgs.pageId);
        } catch (error) {
          if (error instanceof McpError) throw error;
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to read page ${toolArgs.pageId} before updating it: ` +
              `${error instanceof Error ? error.message : String(error)}. The page was not ` +
              `modified. The current version and title are read before every write so the ` +
              `caller does not have to supply them (design.md D5).`
          );
        }
        return currentPage;
      };

      // Preflight, ordered per design.md D10. The content-only checks need nothing from
      // Confluence, so malformed or markdown content is rejected without a single request;
      // the current page is fetched lazily, only if the pipeline reaches construct-loss.
      await assertWriteIsSafe({
        content: toolArgs.content,
        allowMarkdownContent: toolArgs.allowMarkdownContent,
        confirmConstructRemoval: toolArgs.confirmConstructRemoval,
        currentContent: async () => {
          const page = await loadCurrentPage();
          assertExpectedVersion(toolArgs.expectedVersion, page.version.number);
          return page.body?.storage?.value ?? '';
        },
      });

      const page = await loadCurrentPage();
      // Repeated because `confirmConstructRemoval` short-circuits the check above before the
      // resolver runs. Pure and idempotent, so running it twice costs nothing.
      assertExpectedVersion(toolArgs.expectedVersion, page.version.number);

      const title = toolArgs.title ?? page.title;
      const nextVersion = resolveWriteVersion(page.version.number);

      try {
        const updated = await client.updateConfluencePage(
          toolArgs.pageId,
          title,
          toolArgs.content,
          nextVersion
        );

        // Update cache with the latest instance info
        await cachePageInstance(updated.id, updated.spaceId, instanceName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Page updated successfully',
                  pageId: updated.id,
                  title: updated.title,
                  version: updated.version.number,
                  url: updated._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        // A concurrent edit can land between resolving the version and submitting the write.
        // Confluence rejecting it is reported in the SAME shape as the local check
        // (design.md D12), so a caller has one case to handle.
        if (isVersionConflictResponse(error)) {
          let liveVersion: number | null = null;
          try {
            liveVersion = (await client.getConfluencePage(toolArgs.pageId)).version.number;
          } catch {
            // Re-read failed; the conflict is still reported, with the version unknown.
          }
          // The re-read also DISPROVES a conflict. Confluence answers 409 for more than a
          // stale version -- a duplicate title in the space is the other common case, and
          // `title` is still a supported parameter. If nothing moved, the 409 was about
          // something else, and reporting "expected version 7 but the page is at version 7"
          // would be both wrong and self-contradictory. Fall through to Confluence's own
          // message instead.
          if (liveVersion === null || liveVersion !== page.version.number) {
            throw versionConflictError({
              expectedVersion: page.version.number,
              currentVersion: liveVersion,
            });
          }
        }

        console.error(
          'Error updating page:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to update page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

interface MovePageArgs extends ToolArgs {
  pageId: string;
  targetParentId: string;
  position?: 'append' | 'before' | 'after';
}

export async function handleMoveConfluencePage(args: MovePageArgs) {
  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      try {
        // Get the page info before moving for response details
        const page = await client.getConfluencePage(toolArgs.pageId);
        const targetParent = await client.getConfluencePage(toolArgs.targetParentId);

        // Perform the move operation
        await client.moveConfluencePage(
          toolArgs.pageId,
          toolArgs.targetParentId,
          toolArgs.position || 'append'
        );

        // Update cache - the page is now under a different parent potentially in a different space
        await cachePageInstance(page.id, targetParent.spaceId, instanceName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: 'Page moved successfully',
                  pageId: toolArgs.pageId,
                  pageTitle: page.title,
                  targetParentId: toolArgs.targetParentId,
                  targetParentTitle: targetParent.title,
                  targetSpaceId: targetParent.spaceId,
                  position: toolArgs.position || 'append',
                  url: page._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error('Error moving page:', error instanceof Error ? error.message : String(error));
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to move page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
