## Purpose

Lets a caller replace, append to, or insert one identified section of a Confluence page while
every byte outside that section — including macros, layouts, and third-party app content — is
carried through untouched, so an edit cannot damage content the caller never looked at.

## ADDED Requirements

### Requirement: A section is addressed by heading

Section editing SHALL identify the target section by its heading text. A section comprises the
heading and all content following it up to, but excluding, the next heading of the same or
higher level, or the end of the page.

#### Scenario: Section located by heading text

- **WHEN** an edit targets the heading `Deployment Steps` on a page containing that heading
- **THEN** the section beginning at that heading is selected

#### Scenario: Section ends at the next same-level heading

- **WHEN** a level-2 heading is followed by content and then another level-2 heading
- **THEN** the selected section includes the content between them and excludes the second heading

#### Scenario: Subsections are included

- **WHEN** a level-2 heading is followed by a level-3 heading and its content, then a level-2 heading
- **THEN** the selected section includes the level-3 heading and its content

#### Scenario: Final section ends at the end of the page

- **WHEN** the targeted heading is the last heading on the page
- **THEN** the selected section extends to the end of the page content

### Requirement: Ambiguous section references are rejected

When the requested heading text matches more than one heading, the operation SHALL fail rather
than guess. The caller SHALL be able to disambiguate by supplying an occurrence index.

#### Scenario: Duplicate heading without an index is rejected

- **WHEN** an edit targets a heading whose text matches two headings and no occurrence index is given
- **THEN** an error is returned reporting how many matches were found
- **AND** the page is not modified

#### Scenario: Occurrence index selects the intended match

- **WHEN** an edit targets a duplicated heading and supplies an occurrence index
- **THEN** the section at that occurrence is selected

#### Scenario: Missing heading is rejected

- **WHEN** an edit targets a heading that does not exist on the page
- **THEN** an error is returned stating that the heading was not found
- **AND** the error lists the headings that do exist
- **AND** the page is not modified

### Requirement: Content outside the edited section is preserved byte-for-byte

A section edit SHALL leave all page content outside the targeted section byte-for-byte
identical. Content outside the target SHALL NOT be parsed, re-serialized, or normalized.

#### Scenario: Macros elsewhere on the page are untouched

- **WHEN** a section is replaced on a page whose other sections contain structured macros
- **THEN** those macros are byte-for-byte identical in the resulting page content

#### Scenario: Layouts elsewhere on the page are untouched

- **WHEN** a section is replaced on a page containing a layout outside the target section
- **THEN** that layout is byte-for-byte identical in the resulting page content

#### Scenario: Unknown third-party markup is untouched

- **WHEN** a section is replaced on a page containing markup the server does not recognize,
  outside the target section
- **THEN** that markup is byte-for-byte identical in the resulting page content

#### Scenario: Content before and after is preserved

- **WHEN** a section in the middle of a page is replaced
- **THEN** all content before the section's heading is unchanged
- **AND** all content after the section's end is unchanged

### Requirement: Supported section operations

Section editing SHALL support replacing a section's body, appending content to the end of a
section, and inserting a new section relative to an existing one.

#### Scenario: Replace a section body

- **WHEN** a replace operation targets a section with new content
- **THEN** the section's heading is retained
- **AND** the section's previous body is substituted with the supplied content

#### Scenario: Append to a section

- **WHEN** an append operation targets a section with new content
- **THEN** the supplied content is added at the end of that section
- **AND** the section's existing body is retained ahead of it

#### Scenario: Insert a new section after an existing one

- **WHEN** an insert operation names an existing heading and supplies a new heading and body
- **THEN** the new section is placed immediately after the named section
- **AND** the named section is unchanged

### Requirement: Submitted section content must be valid storage format

Content supplied for a section SHALL be Confluence storage format. The operation SHALL reject
content that is not well-formed before writing to Confluence.

#### Scenario: Malformed content is rejected before the write

- **WHEN** a section edit supplies content that is not well-formed storage format
- **THEN** an error is returned describing the defect
- **AND** no request to modify the page is made

#### Scenario: Well-formed content is accepted

- **WHEN** a section edit supplies well-formed storage format content
- **THEN** the edit proceeds

### Requirement: Section edits are subject to the shared write safety contract

Every section edit SHALL apply the same title preservation, version resolution, and conflict
detection guarantees that govern whole-page writes.

#### Scenario: Section edit preserves the page title

- **WHEN** a section edit completes without supplying a title
- **THEN** the page's title is unchanged

#### Scenario: Section edit detects a concurrent modification

- **WHEN** a section edit supplies an expected version and the page has since been modified
- **THEN** the edit fails reporting the conflict
- **AND** the page is not modified
