/**
 * Pre-submit content validation (spec: page-write-safety, reused read-only).
 *
 * Every write tool in this server runs the same preflight pipeline and rejects on the FIRST
 * failure. That is right for a write -- the most actionable thing is said first, and nothing
 * downstream needs computing once the write is refused -- but it makes an agent discover
 * problems one round trip at a time, and only by attempting a write.
 *
 * This tool inverts that: same pipeline, same checks, same order, but every failure is
 * reported and NOTHING is written. It calls `preflightAll`, which is the same
 * `runPreflightPipeline` the write path calls with `stopAtFirstFailure`; there is deliberately
 * no second copy of the check list here. A validator that can disagree with the write path is
 * worse than no validator, because an agent that validates clean and is then rejected trusts
 * neither.
 *
 * READ-ONLY, unconditionally. The only Confluence call it can make is `getConfluencePage`, and
 * only when `pageId` is supplied.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { Page } from '../types/index.js';
import { withConfluenceContext } from '../utils/tool-wrapper.js';
import type { ToolArgs } from '../utils/tool-wrapper.js';
import {
  PREFLIGHT_CHECK_ORDER,
  preflightAll,
  type PreflightCheckName,
  type PreflightFailure,
} from '../utils/write-safety.js';

interface ValidateContentArgs extends ToolArgs {
  content: string;
  pageId?: string;
  allowMarkdownContent?: boolean;
  confirmConstructRemoval?: boolean;
}

interface SkippedCheck {
  check: PreflightCheckName;
  reason: string;
}

/**
 * Nothing in this server enforces a schema's `required` array at runtime, so a dropped
 * `content` would otherwise reach `tokenize(undefined)` and surface as an internal error
 * instead of the obvious message. Same pattern as `section-handlers.ts`.
 */
function requireContent(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new McpError(
    ErrorCode.InvalidParams,
    `"content" must be a string of Confluence storage format (XHTML) to validate, received ` +
      `${JSON.stringify(value)}. Pass an explicit empty string to validate empty content. ` +
      `Nothing was validated and nothing was written -- this tool never writes.`
  );
}

const SECTION_SCOPE_NOTE =
  'construct-loss here compares against the WHOLE page body, which is exactly what ' +
  'update_confluence_page does. When validating a fragment for replace_confluence_section, ' +
  'OMIT pageId: that tool scopes construct-loss to the section being replaced, so a ' +
  'whole-page comparison would report macros elsewhere on the page as lost.';

const CONTENT_ONLY_NOTE =
  'construct-loss is the only check that needs a comparison target, and no pageId was ' +
  'supplied, so it was not evaluated. That makes this verdict complete for ' +
  'create_confluence_page, append_confluence_section and insert_confluence_section (none of ' +
  'them removes anything). For update_confluence_page, supply pageId. For ' +
  'replace_confluence_section, this is the right call: its construct-loss check is scoped to ' +
  'the section being replaced and runs at write time.';

function describeProblem(failure: PreflightFailure, index: number) {
  return {
    check: failure.check,
    /** The first problem is the one a write attempt would be rejected on (PREFLIGHT_CHECK_ORDER). */
    primary: index === 0,
    problem: failure.message,
    ...(failure.location === undefined ? {} : { location: failure.location }),
    action: failure.remedy,
  };
}

function buildReport(options: {
  failures: PreflightFailure[];
  instanceName?: string;
  page?: Page;
  allowMarkdownContent: boolean;
  confirmConstructRemoval: boolean;
}) {
  const { failures, page, allowMarkdownContent, confirmConstructRemoval } = options;

  const skipped: SkippedCheck[] = [];
  if (allowMarkdownContent) {
    skipped.push({
      check: 'markdown',
      reason:
        'Not evaluated: allowMarkdownContent: true was supplied, which suppresses this check ' +
        'on the write path too. Drop the flag to have the content checked as storage format.',
    });
  }
  if (page === undefined) {
    skipped.push({ check: 'construct-loss', reason: CONTENT_ONLY_NOTE });
  } else if (confirmConstructRemoval) {
    skipped.push({
      check: 'construct-loss',
      reason:
        'Not evaluated: confirmConstructRemoval: true was supplied, which waives this check ' +
        'on the write path too. Drop the flag to see what the write would remove.',
    });
  }

  // Derived from the exported order constant rather than a hardcoded list, so a future check
  // cannot be added to the pipeline and silently missed here.
  const checksRun = PREFLIGHT_CHECK_ORDER.filter(
    (name) => !skipped.some((entry) => entry.check === name)
  );

  const valid = failures.length === 0;
  const overrides = {
    ...(allowMarkdownContent ? { allowMarkdownContent: true } : {}),
    ...(confirmConstructRemoval ? { confirmConstructRemoval: true } : {}),
  };
  const waived = Object.keys(overrides).length > 0;

  const summary = valid
    ? `Ready to write. Every check the write path runs passed${
        waived ? ' (with the overrides below applied)' : ''
      }: ${checksRun.join(', ')}. ${
        page === undefined
          ? CONTENT_ONLY_NOTE
          : `Compared against page ${page.id} at version ${page.version.number}. ` +
            'A write can still fail on a stale expectedVersion or a concurrent edit -- ' +
            'content is what was checked here.'
      }`
    : `${failures.length} problem(s) found. A write with this content would be rejected on ` +
      `the first one (${failures[0]!.check}) -- the write path stops there, so fix them all ` +
      `and validate again before submitting. Nothing was written.`;

  return {
    ...(options.instanceName === undefined ? {} : { instance: options.instanceName }),
    valid,
    scope: page === undefined ? 'content-only' : 'content-and-page',
    ...(page === undefined
      ? {}
      : {
          page: {
            pageId: page.id,
            title: page.title,
            version: page.version.number,
            note:
              `Pass version ${page.version.number} as expectedVersion on the write this ` +
              `content is for. ${SECTION_SCOPE_NOTE}`,
          },
        }),
    checksRun,
    ...(skipped.length === 0 ? {} : { checksSkipped: skipped }),
    ...(waived ? { overridesApplied: overrides } : {}),
    problemCount: failures.length,
    problems: failures.map(describeProblem),
    summary,
    readOnly: 'This tool never writes to Confluence. Validating changes nothing.',
  };
}

function asToolResult(report: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(report, null, 2),
      },
    ],
  };
}

/**
 * Validate content against the write-safety contract without writing.
 *
 * With no `pageId` this makes NO request to Confluence at all -- not even instance resolution
 * -- so it is free to call as often as an agent needs while iterating on a draft.
 */
export async function handleValidateConfluenceContent(args: ValidateContentArgs) {
  const content = requireContent(args.content);
  const allowMarkdownContent = args.allowMarkdownContent === true;
  const confirmConstructRemoval = args.confirmConstructRemoval === true;

  if (args.pageId === undefined || args.pageId === null || args.pageId === '') {
    const failures = await preflightAll({
      content,
      allowMarkdownContent,
      confirmConstructRemoval,
    });
    return asToolResult(buildReport({ failures, allowMarkdownContent, confirmConstructRemoval }));
  }

  const pageId = args.pageId;
  if (typeof pageId !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"pageId" must be a string, received ${JSON.stringify(pageId)}. Nothing was written.`
    );
  }

  return withConfluenceContext(
    args,
    { requiresPage: true },
    async (toolArgs, { client, instanceName }) => {
      let page: Page;
      try {
        page = await client.getConfluencePage(pageId);
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read page ${pageId} to validate against it: ` +
            `${error instanceof Error ? error.message : String(error)}. Nothing was written. ` +
            `Omit pageId to run the content-intrinsic checks, which need no page at all.`
        );
      }

      const failures = await preflightAll({
        content,
        currentContent: page.body?.storage?.value ?? '',
        allowMarkdownContent: toolArgs.allowMarkdownContent === true,
        confirmConstructRemoval: toolArgs.confirmConstructRemoval === true,
      });

      return asToolResult(
        buildReport({
          failures,
          instanceName,
          page,
          allowMarkdownContent,
          confirmConstructRemoval,
        })
      );
    }
  );
}
