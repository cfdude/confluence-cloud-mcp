## Why

AI agents using this MCP server cannot reliably edit an existing Confluence page. Two
defects in `src/utils/content-converter.ts` silently destroy content on read, and a format
asymmetry between the read and write paths means a read-then-write round trip discards every
macro and layout on the page even when the converter behaves.

The converter defect is confirmed, not suspected. `convertStorageToMarkdown` passes a
**function** as `String.replace`'s second argument and returns a template literal containing
`$1`; when the replacement is a function, `$1` is not a capture-group reference and is emitted
literally. Every ordered-list item's text is replaced by the characters `$1`. Verified against
the shipped build:

```
in : <p>Steps:</p><ol><li>Open the console</li><li>Click <strong>Deploy</strong></li>
     <li>Wait for green</li></ol><ul><li>note A</li><li>note B</li></ul>
out: Steps:

     1. $1 2. $1 3. $1 * note A * note B
```

That output also exposes a second defect: a line-joining rule collapses every list, bullets
included, onto a single line.

The `$1` tokens have long been assumed to be Confluence macro syntax that agents should
preserve. They are not. A scan of 3,942 pages across two Atlassian sites, reading raw
`body-format=storage` with the converter bypassed, found 2,113 pages containing macros and
**zero** of them producing a `$1` token; exactly 2 pages carry the `N. $1` corruption
signature, 27 list items in total, both written back through this server. The assumption was
inverted: agents were being told to preserve corrupted output, and in two cases they wrote it
back to live Confluence.

The deeper problem outlives the regex fix. `get_confluence_page` returns markdown and discards
the raw storage it already fetched, while `create`/`update` demand storage XHTML. An agent
therefore reads one format and must author another, from a source that has already flattened
`<ac:structured-macro>` to the literal text `[Confluence Macro: name]` and dropped layouts
entirely. Whole-page rewriting from that input destroys macros no matter how good the
converter becomes.

## What Changes

- **Fix both converter defects.** Ordered-list items keep their text; lists are no longer
  collapsed onto one line.
- **`get_confluence_page` gains a `format` parameter** — `'markdown' | 'storage' | 'both'`,
  defaulting to `'both'`. Agents can retrieve the raw storage XHTML alongside the readable
  markdown and write back the exact format they read. The raw storage is already fetched
  today and thrown away; this stops discarding it.
- **New section-scoped edit tools.** Locate one section by heading, splice only that region
  server-side, write the whole page back. Content outside the targeted section — including
  every macro and layout on the page — is passed through byte-for-byte and never parsed, so
  it cannot be damaged. Confluence v2 has no PATCH endpoint, so the splice is ours.
- **Whole-page writes remain supported and are hardened.** They stay the escape hatch for
  cases section-scoping cannot express, with preflight checks that catch the destructive
  submissions agents actually make.
- **BREAKING (permissive direction): `title` becomes optional on `update_confluence_page`.**
  It is required today, so an agent editing only body content must restate the title and a
  paraphrase silently renames the page. When omitted, the current title is preserved
  server-side. Existing callers that pass a title are unaffected.
- **Version handling moves server-side.** The client currently forwards the agent-supplied
  version verbatim while the tool description instructs the agent to increment it by one; an
  off-by-one yields a 409. The server resolves the correct next version, and an optional
  `expectedVersion` provides real optimistic-concurrency conflict detection.
- **Storage-format fixtures and round-trip tests** covering ordered lists, nested lists,
  tables, macros, and layouts. The repository has exactly one test file today, so these
  fixtures are the regression net for this work, not a follow-up chore.

## Capabilities

### New Capabilities

- `content-conversion`: Converting Confluence storage format to readable markdown without
  losing or corrupting content, and the fidelity guarantees that conversion must meet.
- `page-content-retrieval`: Retrieving page content in a caller-selected representation —
  markdown, raw storage, or both — so that what an agent reads can be written back.
- `page-section-editing`: Editing one identified section of a page while passing all
  surrounding content through unmodified.
- `page-write-safety`: The safety contract shared by every write path — title preservation,
  version resolution, conflict detection, and preflight checks that reject destructive
  submissions.

### Modified Capabilities

<!-- None. openspec/specs/ is empty; this change introduces the project's first capabilities. -->

## Impact

**Code**
- `src/utils/content-converter.ts` — both defects; fidelity requirements.
- `src/handlers/page-handlers.ts` — `format` parameter; stop discarding raw storage; new
  section-edit handlers; title preservation.
- `src/client/confluence-client.ts` — version resolution, `expectedVersion` conflict
  detection, fetching current page state for preflight checks.
- `src/schemas/tool-schemas.ts` — `format` on reads, `title` optional, new section-edit tool
  schemas. Description text is deliberately minimal here; the full rewrite is a separate
  change.
- `src/types/index.ts` — types for the new representations and edit operations.
- `__tests__/` — storage-format fixtures and round-trip tests.

**APIs** — No new Confluence endpoints. Existing `/wiki/api/v2` and `/wiki/rest/api` base
URLs are correct and stay as they are: v2 has no CQL search and no content-properties
equivalent, so the mixed usage is required rather than drift.

**Dependencies** — None added. `atlas_doc_format` is explicitly not adopted; ADF is neither
lossless for macros nor recommended by Atlassian for programmatic editing, and removal of the
unused `@atlaskit` packages is a separate change.

**Behavior** — Agents that already pass `title` see no change. Agents relying on
`get_confluence_page` returning a bare markdown string see a richer response shape by default.

**Not in this change** — the pre-submit validator (`content-validator`), tool description
rewrites (`tool-doc-overhaul`), dependency and ADF removal (`deps-security-sweep`), and
repairing the 2 corrupted live pages (`repair-corrupted-pages`).
