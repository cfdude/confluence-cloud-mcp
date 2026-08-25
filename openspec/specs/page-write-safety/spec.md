# page-write-safety Specification

## Purpose
Defines the safety contract every write path shares — title preservation, version resolution,
conflict detection, and preflight checks — so that an agent cannot silently rename a page,
lose a concurrent edit, or destroy macros by submitting content derived from a lossy read.

## Requirements

### Requirement: Title is optional and preserved when omitted

Updating a page SHALL NOT require a title. When no title is supplied, the page's existing
title SHALL be preserved.

#### Scenario: Update without a title keeps the current title

- **WHEN** a page is updated with new content and no title
- **THEN** the page's title after the update is identical to its title before
- **AND** the content is updated

#### Scenario: Update with a title applies it

- **WHEN** a page is updated with a title that differs from the current one
- **THEN** the page's title is changed to the supplied value

#### Scenario: Update with an unchanged title is not treated as a rename

- **WHEN** a page is updated with a title identical to its current title
- **THEN** the update succeeds and the title is unchanged

### Requirement: The server resolves the version to write

The server SHALL determine the version number submitted to Confluence. A caller SHALL NOT be
required to compute or increment a version number.

#### Scenario: Update without a supplied version succeeds

- **WHEN** a page is updated without supplying any version
- **THEN** the server resolves the page's current version
- **AND** submits the write with the correct next version
- **AND** the update succeeds

#### Scenario: Caller-supplied version is not forwarded verbatim

- **WHEN** a page at version 7 is updated
- **THEN** the version submitted to Confluence is 8
- **AND** the update does not fail with a version conflict caused by an off-by-one

### Requirement: Optimistic concurrency via expected version

Writes SHALL accept an optional `expectedVersion`. When supplied, the write SHALL proceed only
if the page is still at that version, and SHALL fail without modifying the page otherwise.

#### Scenario: Matching expected version proceeds

- **WHEN** a write supplies an `expectedVersion` equal to the page's current version
- **THEN** the write proceeds

#### Scenario: Stale expected version is rejected

- **WHEN** a write supplies an `expectedVersion` lower than the page's current version
- **THEN** the write fails reporting a conflict
- **AND** the error states both the expected and the current version
- **AND** the page is not modified

#### Scenario: Omitted expected version skips the check

- **WHEN** a write supplies no `expectedVersion`
- **THEN** no conflict check is performed and the write proceeds

### Requirement: Whole-page writes are checked for destructive content loss

Before replacing a page's entire content, the server SHALL compare the submitted content
against the page's current content and SHALL reject a submission that would remove macros or
layouts present in the current version, unless the caller explicitly confirms the removal.

#### Scenario: Submission dropping a macro is rejected

- **WHEN** a whole-page write submits content containing no macros, and the current page
  contains a structured macro
- **THEN** the write is rejected reporting which macros would be lost
- **AND** the page is not modified

#### Scenario: Submission dropping a layout is rejected

- **WHEN** a whole-page write submits content that omits a layout present in the current page
- **THEN** the write is rejected reporting that the layout would be lost
- **AND** the page is not modified

#### Scenario: Explicit confirmation permits the removal

- **WHEN** a whole-page write would remove macros and the caller explicitly confirms the
  removal is intended
- **THEN** the write proceeds

#### Scenario: Submission retaining macros proceeds

- **WHEN** a whole-page write submits content retaining every macro present in the current page
- **THEN** the check passes and the write proceeds

#### Scenario: Page with no macros is unaffected by the check

- **WHEN** a whole-page write targets a page containing no macros or layouts
- **THEN** the check passes and the write proceeds

### Requirement: Content bearing conversion artifacts is rejected

The server SHALL reject submitted content containing markdown-conversion artifacts that
indicate the caller is writing back a corrupted read, so such content cannot reach Confluence.
Detection SHALL cover the artifact both as element content and as bare text, because the
observed corruption on live pages appears as unwrapped text rather than as list elements.

#### Scenario: Bare textual placeholder is rejected

- **WHEN** submitted content contains a single occurrence of the text `1. $1` outside a code
  block, where the `$1` is not followed by a digit
- **THEN** the write is rejected identifying the affected text
- **AND** the page is not modified

#### Scenario: Placeholder list element is rejected

- **WHEN** submitted content contains a list item whose entire text is the token `$1`
- **THEN** the write is rejected identifying the affected item
- **AND** the page is not modified

#### Scenario: Dollar amounts are accepted

- **WHEN** submitted content contains a dollar amount such as `$1.2M`, `$1K`, or `$1,505,674`
- **THEN** the write is not rejected on that basis

#### Scenario: Parameter placeholders in code are accepted

- **WHEN** submitted content contains a parameter placeholder such as `$1::vector` within a
  code block or preformatted region
- **THEN** the write is not rejected on that basis

### Requirement: Markdown submitted as storage format is rejected

Storage format is XHTML; markdown syntax placed in it renders as literal characters rather
than as formatting. The server SHALL reject submitted content that carries markdown structural
syntax outside code and preformatted regions, and the error SHALL tell the caller to supply
storage format and how to obtain it.

#### Scenario: Markdown heading is rejected

- **WHEN** submitted content contains a line beginning with two to six `#` characters followed
  by a space, outside a code or preformatted region
- **THEN** the write is rejected reporting that the content appears to be markdown
- **AND** the error states that storage format is required
- **AND** the page is not modified

#### Scenario: Single leading hash is not treated as a markdown heading

- **WHEN** submitted content contains a line beginning with exactly one `#` followed by a space
  and no other markdown structural signal
- **THEN** the write is not rejected on that basis

#### Scenario: Bare bullet alone is NOT rejected

- **WHEN** submitted content contains a line beginning with `-` or `*` followed by a space,
  and contains no other markdown structural signal
- **THEN** the write is not rejected on that basis

#### Scenario: Bullet accompanying another markdown signal is rejected

- **WHEN** submitted content contains a line beginning with `-` or `*` followed by a space,
  and also contains a markdown heading or `**` emphasis outside a code region
- **THEN** the write is rejected reporting that the content appears to be markdown

#### Scenario: Markdown emphasis is rejected

- **WHEN** submitted content contains `**` delimited emphasis outside a code or preformatted
  region
- **THEN** the write is rejected reporting that the content appears to be markdown

#### Scenario: Markdown fenced code block is rejected

- **WHEN** submitted content contains a triple-backtick fence outside a preformatted region
- **THEN** the write is rejected reporting that the content appears to be markdown

#### Scenario: Error explains how to obtain storage format

- **WHEN** a write is rejected as markdown
- **THEN** the error directs the caller to retrieve the page with the storage representation
  and author against that

#### Scenario: Markdown syntax inside a code block is accepted

- **WHEN** submitted content contains markdown syntax inside a code or preformatted region
- **THEN** the write is not rejected on that basis

#### Scenario: Hyphen in ordinary prose is accepted

- **WHEN** submitted content contains a hyphen or asterisk that is not at the start of a line
  followed by a space
- **THEN** the write is not rejected on that basis

#### Scenario: Valid storage content is accepted

- **WHEN** submitted content uses storage format elements such as `<h2>`, `<ul><li>`, and
  `<strong>` and contains no markdown structural syntax
- **THEN** the check passes and the write proceeds

#### Scenario: Dedicated override permits intentional markdown-like prose

- **WHEN** a write would be rejected as markdown and the caller sets the markdown override flag
- **THEN** the write proceeds

#### Scenario: Construct-removal confirmation does not override markdown rejection

- **WHEN** a write would be rejected as markdown and the caller sets only the construct-removal
  confirmation flag
- **THEN** the write is still rejected as markdown

### Requirement: This server's macro-placeholder text is rejected

Markdown rendering represents a macro as the placeholder text `[Confluence Macro: …]`. That
text appearing in submitted content is proof the caller is writing back a lossy rendering, so
the server SHALL reject it.

#### Scenario: Macro placeholder text is rejected

- **WHEN** submitted content contains the text `[Confluence Macro:` followed by a macro name
- **THEN** the write is rejected reporting that the content contains a rendered macro
  placeholder rather than macro markup
- **AND** the error directs the caller to retrieve the page with the storage representation
- **AND** the page is not modified

#### Scenario: Placeholder inside a code block is accepted

- **WHEN** the placeholder text appears inside a code or preformatted region, such as
  documentation describing the format
- **THEN** the write is not rejected on that basis

### Requirement: Preflight checks run in a fixed order

Checks SHALL be evaluated in the order well-formedness, markdown-as-storage,
conversion-artifact, construct-loss, so that the most specific and actionable error is the one
returned.

#### Scenario: Markdown content reports the markdown error, not construct loss

- **WHEN** submitted content is markdown and the current page contains a macro
- **THEN** the returned error reports that the content appears to be markdown
- **AND** does not report construct loss as the primary failure

### Requirement: Page creation is subject to the content checks

Creating a page SHALL apply the same well-formedness, markdown-as-storage,
conversion-artifact, and macro-placeholder checks as updating one. Construct-loss detection
does not apply, as there is no prior version to compare against.

#### Scenario: Creating a page with markdown content is rejected

- **WHEN** a page is created with content carrying markdown structural syntax outside a code
  region
- **THEN** the creation is rejected reporting that the content appears to be markdown
- **AND** no page is created

#### Scenario: Creating a page with conversion artifacts is rejected

- **WHEN** a page is created with content carrying the `$1` artifact signature
- **THEN** the creation is rejected
- **AND** no page is created

#### Scenario: Creating a page with valid storage succeeds

- **WHEN** a page is created with well-formed storage content containing no markdown syntax
- **THEN** the page is created

### Requirement: Conflicts report identically however they are detected

A concurrent edit may land between the server resolving the current version and submitting the
write. Whether a conflict is caught by the server's own comparison or reported by Confluence
rejecting the submitted version, the caller SHALL receive the same conflict error shape.

#### Scenario: Conflict detected locally

- **WHEN** a supplied expected version does not match the version the server resolves
- **THEN** a conflict error is returned identifying the expected and current versions

#### Scenario: Conflict detected by Confluence after version resolution

- **WHEN** the page is modified by another author between version resolution and submission,
  and Confluence rejects the write
- **THEN** a conflict error is returned in the same shape as a locally detected conflict
- **AND** the error is not surfaced as an unclassified API failure

### Requirement: Submitted content must be well-formed storage format

Every write SHALL validate that submitted content is well-formed Confluence storage format
before contacting Confluence.

#### Scenario: Malformed content is rejected locally

- **WHEN** a write submits content that is not well-formed storage format
- **THEN** an error is returned describing the defect and its location
- **AND** no request to modify the page is made

### Requirement: Rejected writes leave the page unmodified

When any preflight check fails, the server SHALL make no modifying request to Confluence, and
the error SHALL state what to correct.

#### Scenario: Failed check makes no write request

- **WHEN** any preflight check rejects a write
- **THEN** no modifying request is sent to Confluence
- **AND** the returned error describes the specific failure and the corrective action
