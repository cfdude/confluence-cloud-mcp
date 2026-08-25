## Purpose

Lets a caller replace, append to, or insert one identified section of a Confluence page while
every byte outside that section — including macros, layouts, and third-party app content — is
carried through untouched, so an edit cannot damage content the caller never looked at.

## ADDED Requirements

### Requirement: Only headings outside opaque regions are addressable

A heading SHALL be addressable only when every ancestor between it and the document root is a
sectioning container. Layout elements SHALL be treated as sectioning containers. Macro bodies
and table cells SHALL be treated as opaque: headings inside them are neither addressable nor
considered when determining any other section's extent.

#### Scenario: Heading inside a macro body is not addressable

- **WHEN** an edit targets heading text that occurs only inside a macro body
- **THEN** an error is returned stating that the heading was not found among addressable headings
- **AND** the page is not modified

#### Scenario: Heading inside a macro body does not truncate an enclosing section

- **WHEN** a section's content includes a macro whose body contains a heading of the same level
- **THEN** the section's extent continues past that macro
- **AND** the macro is preserved byte-for-byte when the section is replaced

#### Scenario: Heading inside a table cell is not addressable

- **WHEN** an edit targets heading text that occurs only inside a table cell
- **THEN** an error is returned stating that the heading was not found among addressable headings

#### Scenario: Heading inside a layout cell is addressable

- **WHEN** an edit targets a heading contained in a layout cell
- **THEN** the section is resolved and the edit proceeds

#### Scenario: A section does not extend beyond its layout cell

- **WHEN** the targeted heading is the last heading within a layout cell
- **THEN** the section's extent ends at the end of that layout cell
- **AND** content in subsequent layout cells is unchanged

#### Scenario: Resolved boundaries share one container

- **WHEN** section resolution cannot place the section's start and end within the same
  sectioning container
- **THEN** the edit is rejected rather than spliced
- **AND** the page is not modified

### Requirement: A section is addressed by heading

Section editing SHALL identify the target section by its heading text. A section comprises the
heading and all content following it up to, but excluding, the next addressable heading of the
same or higher level within the same sectioning container, or the end of that container.

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
- **THEN** the section's heading is retained without the caller re-supplying it
- **AND** only the content between the end of the heading and the end of the section is
  substituted with the supplied content
- **AND** the heading is not duplicated in the result

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

### Requirement: The assembled document is validated before writing

Validating the supplied fragment alone is insufficient — a fragment well-formed in isolation
can still produce a malformed document once spliced. The server SHALL validate the fully
assembled page content before submitting it.

#### Scenario: Assembly producing malformed content is rejected

- **WHEN** splicing a well-formed fragment produces a document that is not well-formed
- **THEN** the edit is rejected reporting that assembly produced invalid content
- **AND** no modifying request is sent to Confluence

#### Scenario: Valid assembly proceeds

- **WHEN** splicing produces a well-formed document
- **THEN** the write proceeds

### Requirement: Section edits detect construct loss within the replaced span

A section edit SHALL compare the constructs present in the span being replaced before and
after the edit, and SHALL reject a replacement that drops a macro or layout from that span
unless the caller explicitly confirms the removal. Without this, editing a single section
would be less safe than rewriting the whole page.

#### Scenario: Replacement dropping a macro inside the section is rejected

- **WHEN** a replace operation targets a section containing a macro and supplies content
  omitting that macro
- **THEN** the edit is rejected naming the macro that would be lost
- **AND** the page is not modified

#### Scenario: Confirmed removal proceeds

- **WHEN** a replace operation would drop a macro from the section and the caller confirms the
  removal
- **THEN** the edit proceeds

#### Scenario: Append operations skip the check

- **WHEN** an append or insert operation adds content without replacing existing content
- **THEN** no construct-loss check is performed

#### Scenario: Replacement retaining the macro proceeds

- **WHEN** a replace operation supplies content retaining every macro present in the section
- **THEN** the check passes and the edit proceeds

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

#### Scenario: Section edit rejects markdown supplied as storage

- **WHEN** a section edit supplies content carrying markdown structural syntax outside a code
  region
- **THEN** the edit is rejected reporting that the content appears to be markdown
- **AND** the page is not modified

### Requirement: Section edits require an expected version

Because a section edit necessarily follows a read of the page, the caller already holds the
version. Section editing SHALL require `expectedVersion` and SHALL fail when it is absent, so
that splicing into content that has since changed is impossible.

#### Scenario: Missing expected version is rejected

- **WHEN** a section edit is requested without an expected version
- **THEN** an error is returned stating that an expected version is required
- **AND** the page is not modified

#### Scenario: Stale expected version is rejected before splicing

- **WHEN** a section edit supplies an expected version that no longer matches the page
- **THEN** the edit fails reporting both the expected and current version
- **AND** no splice is attempted and the page is not modified
