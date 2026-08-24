## Purpose

Defines the safety contract every write path shares — title preservation, version resolution,
conflict detection, and preflight checks — so that an agent cannot silently rename a page,
lose a concurrent edit, or destroy macros by submitting content derived from a lossy read.

## ADDED Requirements

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

#### Scenario: Content containing placeholder list items is rejected

- **WHEN** submitted content contains list items whose entire text is the token `$1`
- **THEN** the write is rejected identifying the affected items
- **AND** the page is not modified

#### Scenario: Legitimate content resembling an artifact is accepted

- **WHEN** submitted content contains a dollar amount such as `$1.2M` or a parameter
  placeholder such as `$1::vector` within a code block
- **THEN** the write is not rejected on that basis

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
