## 1. Test harness and real-world fixtures

Fixtures gate everything else (design.md — Migration Plan step 1). Without them the converter
rewrite has no regression net.

- [ ] 1.1 Confirm the Jest harness runs the existing suite from a clean checkout and verify `npm test` passes and reports the one existing test file
- [ ] 1.2 Add a fixture-capture script restricted to the `onvex` site ONLY — never `listreports`/Highway — that fetches raw `body-format=storage` and writes to `__tests__/fixtures/`, and verify it refuses to run against any other configured site (this repository is public; see design.md — Risks)
- [ ] 1.3 Capture storage fixtures covering ordered lists, nested lists, tables, structured macros, layouts, mixed macro-inside-list, and a plain page; sanitize all captured prose, names, figures, and URLs to synthetic equivalents while preserving markup structure verbatim; verify each fixture is non-empty, well-formed, and contains no real page text
- [ ] 1.3a Capture or hand-author fixtures for the nested-heading cases: heading inside `ac:rich-text-body`, heading inside a table cell, heading inside `ac:layout-cell`, and a page whose every heading is inside a layout cell; verify each shape is present
- [ ] 1.4 Add a fixture asserting the exact reported defect — an ordered list whose conversion currently yields `1. $1` — and verify it FAILS against the current converter, proving the fixture detects the bug

## 2. Tokenizer

- [ ] 2.1 Evaluate `parse5` against the macro and layout fixtures for namespaced-element fidelity and source-offset accuracy, and verify a spike round-trips each fixture's raw text from reported offsets with zero byte differences (design.md — D2, Open Questions)
- [ ] 2.2 Adopt `parse5` or the hand-rolled fallback based on 2.1, add the dependency, and verify `npm ls` shows no new transitive advisories via `npm audit`
- [ ] 2.3 Implement the shared tokenizer emitting element/text/comment tokens with source offsets, and verify unit tests cover unknown elements, `ac:`/`ri:` namespaced elements, self-closing tags, and malformed markup without throwing
- [ ] 2.4 Implement construct inventory (macros, layouts, other namespaced elements) over the token stream and verify it reports the expected constructs for each fixture

## 3. Converter rewrite (capability: content-conversion)

- [ ] 3.1 Implement ordered-list conversion over the token stream and verify the 1.4 fixture now passes with item text intact, sequential numbering, and no `$1` token anywhere in the output
- [ ] 3.2 Implement unordered and nested list conversion and verify fixtures assert one item per line and correct relative indentation for nesting
- [ ] 3.3 Remove the global line-joining rule and implement structure-aware whitespace handling, verifying that no fixture's list items are joined onto one line
- [ ] 3.4 Implement heading, paragraph, inline-emphasis, link, code, and table conversion and verify every table cell's text appears in the converted output for the table fixture
- [ ] 3.5 Implement text retention for unrecognized elements and verify a fixture containing an unmodelled element keeps that element's text
- [ ] 3.6 Return the lossy indicator and construct inventory from the conversion and verify macro and layout fixtures report lossy while the plain fixture reports faithful
- [ ] 3.7 Replace silent-failure behavior with a raised error carrying the cause, and verify no partially converted result is ever returned as a success
- [ ] 3.8 Run every fixture through the new converter and verify no output contains a `$1` token and no fixture loses text present in its source

## 4. Retrieval (capability: page-content-retrieval)

- [ ] 4.1 Add the `format` parameter (`markdown` | `storage` | `both`, default `both`) to the get-page tool schema and handler, and verify each value returns exactly the documented fields
- [ ] 4.2 Stop discarding raw storage in the get-page handler and verify the returned storage is byte-for-byte identical to the Confluence response for the macro fixture
- [ ] 4.3 Reject an invalid `format` value with an error naming the accepted values, and verify no page content is returned in that case
- [ ] 4.4 Include the current version in every retrieval response and verify it matches the version reported by the API
- [ ] 4.5 Surface the lossy indicator on retrieval and verify a macro-bearing page is flagged while a plain page is not
- [ ] 4.6 Return the heading outline with levels and occurrence indices, and verify duplicate headings are listed separately with distinguishing indices
- [ ] 4.7 Verify the markdown remains under the existing response key `content` so a caller reading only markdown is unaffected, with storage under a distinct key (design.md — D7)
- [ ] 4.8 Add the same `format` parameter, version, and lossy indicator to `find_confluence_page` and stop discarding its storage, and verify a find-by-title returns storage identical to a get-by-id for the same page (design.md — D11)
- [ ] 4.9 Verify `list_confluence_pages` still does NOT carry full page bodies

## 5. Write safety (capability: page-write-safety)

- [ ] 5.1 Make `title` optional in the update tool schema and preserve the current title server-side when omitted, verifying an update without a title leaves the title unchanged and the content updated
- [ ] 5.2 Resolve the write version server-side as current + 1 and verify a page at version 7 is written as version 8 without the caller supplying a version
- [ ] 5.3 Add optional `expectedVersion` conflict detection and verify a stale value fails reporting both expected and current version, leaving the page unmodified
- [ ] 5.4 Implement well-formedness validation of submitted content and verify malformed input is rejected locally with no modifying request sent
- [ ] 5.5 Implement markdown-as-storage detection for line-initial `##`-`######` (two to six hashes; a single `#` is NOT a signal), `**` emphasis, and triple-backtick fences, evaluated outside `<code>`, `<pre>`, `<ac:plain-text-body>`, and CDATA; verify each is rejected, that the same syntax inside a code block is accepted, and that a bare `-`/`*` bullet ALONE is NOT rejected while a bullet co-occurring with another signal IS (design.md — D8)
- [ ] 5.6 Verify the markdown rejection error names the problem and directs the caller to retrieve with `format: 'storage'` and author against that
- [ ] 5.7 Validate the markdown detector against the real corpus using a ONE-OFF, NON-COMMITTED local script outside `npm test`/CI (separate from the 1.2 fixture tool, which is onvex-gated by design); verify it flags the already-identified corrupted pages and does NOT flag bare-bullet-only pages, and verify the script emits only counts and page ids — never matched Highway text
- [ ] 5.8 Implement conversion-artifact detection covering BOTH the bare-text signature `/[0-9]+\.\s*\$1(?![0-9])/` and a list item whose entire text is `$1`, and verify `$1.2M`, `$1K`, `$1,505,674`, and `$1::vector` are NOT rejected (design.md — D6; the one live corrupted page carries the artifact as bare text with no list markup)
- [ ] 5.9 Implement construct-loss detection comparing current-page and submitted inventories, and verify a submission dropping a macro is rejected naming that macro
- [ ] 5.10 Add the explicit confirmation flag permitting intentional construct removal and verify the write proceeds when it is set
- [ ] 5.11 Implement macro-placeholder detection rejecting `[Confluence Macro: ...]` in submitted content, and verify it is accepted inside a code block (design.md — D8)
- [ ] 5.12 Add a DEDICATED markdown-override flag, distinct from the construct-removal confirmation, and verify the construct-removal flag alone does NOT override a markdown rejection (design.md — D8)
- [ ] 5.13 Enforce check order well-formedness -> markdown -> artifact -> construct-loss, and verify markdown content on a macro-bearing page reports the markdown error rather than construct loss (design.md — D10)
- [ ] 5.14 Apply well-formedness, markdown, artifact, and macro-placeholder checks to `create_confluence_page`, and verify a create carrying markdown or `$1` is rejected and no page is created (design.md — D11)
- [ ] 5.15 Normalize Confluence's own version-mismatch rejection into the same conflict error shape as the local check, and verify both paths return the same shape (design.md — D12)
- [ ] 5.16 Verify every rejected write path sends no modifying request to Confluence and returns an error stating the corrective action

## 6. Section editing (capability: page-section-editing)

- [ ] 6.1 Implement section resolution returning THREE offsets per heading — `headingStart`, `bodyStart`, `sectionEnd` — and verify each operation acts on the span design.md D3 assigns it (replace acts on `bodyStart..sectionEnd`, so the heading survives without the caller re-supplying it and is not duplicated)
- [ ] 6.1a Implement the sectioning-container rule — layout elements are containers; macro bodies and table cells are opaque — and verify with a fixture `<h2>A</h2><p>x</p><ac:structured-macro ac:name="expand"><ac:rich-text-body><h2>B</h2><p>y</p></ac:rich-text-body></ac:structured-macro><p>z</p><h2>C</h2>` that replacing section A leaves the macro and `<p>z</p>` byte-identical (design.md — D3; 275 live Highway pages have a heading inside a macro body)
- [ ] 6.1b Verify a heading inside a macro body or table cell is NOT addressable and returns a not-found error naming addressable headings only
- [ ] 6.1c Verify a heading inside a layout cell IS addressable and its `sectionEnd` stops at that cell's end, using a fixture with two layout cells (238 live Highway pages have every heading inside a layout cell)
- [ ] 6.1e Verify the nearest-container scoping rule on the composite shape — a root-level heading followed by an `ac:layout` whose cells contain headings — and confirm replacing the root-level section preserves the entire layout byte-for-byte, cell headings included (design.md — D3; not present in the current corpus, but the rule must hold)
- [ ] 6.1d Assert the same-container invariant on resolved offsets and verify the edit is rejected rather than spliced when it cannot hold
- [ ] 6.2 Verify subsections are included in a parent section's extent using a fixture with a level-3 heading inside a level-2 section
- [ ] 6.3 Reject ambiguous heading matches without an occurrence index, reporting the match count, and verify the page is not modified
- [ ] 6.4 Support an occurrence index to disambiguate duplicate headings and verify the correct occurrence is selected
- [ ] 6.5 Reject a missing heading with an error listing the headings that do exist, and verify the page is not modified
- [ ] 6.6 Implement the offset-based string splice and verify that after replacing a section on a macro-heavy fixture, the regions before and after are byte-for-byte identical strings (design.md — D3)
- [ ] 6.7 Implement replace-section, append-to-section, and insert-section-after operations and verify each against fixtures for correct placement and heading retention
- [ ] 6.8 Validate submitted section content as well-formed storage before writing and verify malformed content is rejected with no request made
- [ ] 6.8a Validate the ASSEMBLED document after splicing and verify a fragment that is well-formed alone but produces a malformed document is rejected before any write (design.md — D3)
- [ ] 6.8b Implement span-scoped construct-loss detection for replace operations and verify a replacement dropping a macro inside the section is rejected, that confirmation permits it, and that append/insert skip the check (design.md — D6)
- [ ] 6.9 Make `expectedVersion` REQUIRED on section edits and verify a request omitting it is rejected and one with a stale value fails before any splice is attempted (design.md — D9)
- [ ] 6.10 Add the section-edit tool schemas and handlers wired to the shared write-safety contract, and verify title preservation, markdown-as-storage rejection, and conflict detection all apply to section edits
- [ ] 6.11 Verify unknown third-party markup outside the edited section is preserved byte-for-byte using a fixture containing markup the server does not model
- [ ] 6.12 Verify the no-whitespace-adjustment rule: content is inserted verbatim at the offset with no whitespace inserted, trimmed, normalized, or re-indented on either side of a splice (design.md — D3)

## 7. Integration and verification

- [ ] 7.1 Add an end-to-end test covering read-with-storage → section-edit → read-back against fixtures, verifying macros elsewhere on the page are unchanged
- [ ] 7.2 Add an end-to-end test proving the corruption path is closed: attempt to write back content bearing the bare-text `$1` signature and verify it is rejected
- [ ] 7.2a Add an end-to-end test proving the dominant failure mode is closed: attempt to write markdown into the storage field and verify it is rejected with the corrective message
- [ ] 7.3 Run `npm run lint` and `npm run build` and verify both pass with no errors
- [ ] 7.4 Run the full test suite and verify every test passes, including the pre-existing search test
- [ ] 7.5 Exercise the changed tools against the live `onvex` instance in the `APA` space using `TEST:`-prefixed pages, verify create/read/section-edit/whole-page-update behave per spec, and delete the test pages afterward
- [ ] 7.6 Re-run the corruption scan against both configured sites using the 5.7 one-off script, inheriting its output constraint (counts and page ids only, never matched text), and verify no new `N. $1` or markdown-in-storage occurrences were introduced by this work
