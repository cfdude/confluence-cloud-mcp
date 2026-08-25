/**
 * Section-edit tools (spec: page-section-editing; design.md D3, D6, D9, D12).
 *
 * Three tools, one pipeline. Each reads the page, resolves the target section to offsets,
 * runs the SHARED write-safety contract over the caller's fragment, splices the original
 * string, validates the assembled document, and writes -- in that order, and no further than
 * the first failure.
 *
 * ORDER NOTE for review: the version conflict is checked BEFORE the content checks, which is
 * not a violation of design.md D10. D10 orders the four PREFLIGHT checks relative to one
 * another; task 6.9 separately requires a stale `expectedVersion` to fail "before any splice
 * is attempted", and the page has to be read anyway to resolve the section at all. The
 * preflight pipeline itself still runs in `PREFLIGHT_CHECK_ORDER`, via `assertWriteIsSafe`.
 *
 * There is deliberately no `title` parameter on any of these tools: the current title is
 * always resubmitted, so a section edit cannot rename a page (spec -- "Section edit preserves
 * the page title").
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { Page } from '../types/index.js';
import { cachePageInstance } from '../utils/instance-cache.js';
import {
  assertAssembledWellFormed,
  assertCurrentContentUsable,
  buildInsertedSection,
  operationSpan,
  resolveSection,
  spliceSection,
  type SectionOperation,
} from '../utils/section-editing.js';
import { tokenize } from '../utils/storage-tokenizer.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';
import {
  assertExpectedVersion,
  assertWriteIsSafe,
  isVersionConflictResponse,
  resolveWriteVersion,
  versionConflictError,
} from '../utils/write-safety.js';

interface SectionEditArgs extends ToolArgs {
  pageId: string;
  heading: string;
  occurrence?: number;
  expectedVersion?: number;
  content?: string;
  allowMarkdownContent?: boolean;
  confirmConstructRemoval?: boolean;
  /** insert only. */
  newHeading?: string;
  /** insert only; defaults to the anchor section's level. */
  level?: number;
}

const NOT_MODIFIED = 'The page was not modified.';

/**
 * `expectedVersion` is REQUIRED on section edits (design.md D9, task 6.9).
 *
 * The type is validated, not just the presence. Nothing enforces the JSON schema at runtime
 * in this server, and a caller passing the string `"7"` would otherwise reach
 * `assertExpectedVersion('7', 7)` and be told its perfectly current page is in conflict.
 */
function requireExpectedVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new McpError(
    ErrorCode.InvalidParams,
    `A section edit requires "expectedVersion": the whole-number version the edit was built ` +
      `on, as returned by get_confluence_page. Received ${JSON.stringify(value)}. A section ` +
      `edit splices into content at computed offsets, so it must not run against a page that ` +
      `has changed since it was read. ${NOT_MODIFIED}`
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  throw new McpError(
    ErrorCode.InvalidParams,
    `"${name}" must be a string, received ${JSON.stringify(value)}. ${NOT_MODIFIED}`
  );
}

function optionalOccurrence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new McpError(
    ErrorCode.InvalidParams,
    `"occurrence" must be a whole number of 1 or more, received ${JSON.stringify(value)}. ` +
      `${NOT_MODIFIED}`
  );
}

async function runSectionEdit(args: SectionEditArgs, operation: SectionOperation) {
  // Validated before the wrapper, so a request missing its expected version reaches no
  // Confluence instance at all (task 6.9).
  const expectedVersion = requireExpectedVersion(args.expectedVersion);
  const heading = requireString(args.heading, 'heading');
  const occurrence = optionalOccurrence(args.occurrence);
  // `content` is required for replace and append, and optional only for insert-after (a new
  // section may legitimately be created with a heading and an empty body).
  //
  // Nothing in this server enforces a schema's `required` array at runtime, so treating an
  // omitted `content` as `''` here made a dropped field indistinguishable from a deliberate
  // empty body: `replace` spliced the section's body out entirely and reported success, and
  // `append` became a silent no-op. Span-scoped construct-loss only catches that when the
  // section happens to contain a macro or layout, so an ordinary prose section was destroyed
  // without any error at all -- the exact silent-destruction class this change exists to close.
  const body =
    operation === 'insert-after'
      ? args.content === undefined
        ? ''
        : requireString(args.content, 'content')
      : requireString(args.content, 'content');
  const newHeading =
    operation === 'insert-after' ? requireString(args.newHeading, 'newHeading') : '';

  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      let page: Page;
      try {
        page = await client.getConfluencePage(toolArgs.pageId);
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read page ${toolArgs.pageId} before editing it: ` +
            `${error instanceof Error ? error.message : String(error)}. ${NOT_MODIFIED}`
        );
      }

      // Before any splice is attempted (task 6.9). Same error shape as a conflict Confluence
      // itself reports (design.md D12).
      assertExpectedVersion(expectedVersion, page.version.number);

      const current = page.body?.storage?.value ?? '';
      const tokenized = tokenize(current);
      assertCurrentContentUsable(tokenized);

      const section = resolveSection(tokenized, { heading, occurrence });
      const span = operationSpan(section, operation);

      const fragment =
        operation === 'insert-after'
          ? buildInsertedSection(newHeading, args.level ?? section.level, body)
          : body;

      // The shared contract, span-scoped. Construct-loss compares the constructs in the span
      // being REPLACED against those in the fragment (design.md D6); append and insert remove
      // nothing, so they omit `currentContent` entirely and the check is skipped.
      await assertWriteIsSafe({
        content: fragment,
        label: 'section content',
        allowMarkdownContent: toolArgs.allowMarkdownContent,
        confirmConstructRemoval: toolArgs.confirmConstructRemoval,
        ...(operation === 'replace'
          ? { currentContent: current, currentSpan: { start: span.start, end: span.end } }
          : {}),
      });

      const assembled = spliceSection(current, span, fragment);
      assertAssembledWellFormed(assembled);

      const nextVersion = resolveWriteVersion(page.version.number);

      try {
        const updated = await client.updateConfluencePage(
          toolArgs.pageId,
          page.title,
          assembled,
          nextVersion
        );

        await cachePageInstance(updated.id, updated.spaceId, instanceName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance: instanceName,
                  message: `Section ${JSON.stringify(section.text)} ${describeOutcome(operation)}`,
                  pageId: updated.id,
                  title: updated.title,
                  version: updated.version.number,
                  section: {
                    heading: section.text,
                    level: section.level,
                    occurrence: section.occurrence,
                    operation,
                    container: section.container.name ?? 'page root',
                  },
                  url: updated._links.webui,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        // Same race window and same reporting shape as the whole-page write (design.md D12);
        // see handleUpdateConfluencePage for the reasoning behind the re-read.
        if (isVersionConflictResponse(error)) {
          let liveVersion: number | null = null;
          try {
            liveVersion = (await client.getConfluencePage(toolArgs.pageId)).version.number;
          } catch {
            // Re-read failed; the conflict is still reported, with the version unknown.
          }
          if (liveVersion === null || liveVersion !== page.version.number) {
            throw versionConflictError({
              expectedVersion: page.version.number,
              currentVersion: liveVersion,
            });
          }
        }

        console.error(
          'Error writing section edit:',
          error instanceof Error ? error.message : String(error)
        );
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to update page: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

function describeOutcome(operation: SectionOperation): string {
  if (operation === 'replace') return 'replaced; its heading was retained.';
  if (operation === 'append') return 'appended to.';
  return 'followed by the new section.';
}

/** Replace a section's body, keeping its heading (design.md D3). */
export async function handleReplaceConfluenceSection(args: SectionEditArgs) {
  return runSectionEdit(args, 'replace');
}

/** Append content to the end of a section. */
export async function handleAppendConfluenceSection(args: SectionEditArgs) {
  return runSectionEdit(args, 'append');
}

/** Insert a new section immediately after an existing one. */
export async function handleInsertConfluenceSection(args: SectionEditArgs) {
  return runSectionEdit(args, 'insert-after');
}
