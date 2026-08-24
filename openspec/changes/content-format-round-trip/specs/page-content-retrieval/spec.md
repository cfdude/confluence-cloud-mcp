## Purpose

Lets a caller retrieve a Confluence page's content in the representation it needs — readable
markdown, the raw storage format required for writes, or both — so that what an agent reads
can be written back without translating between mismatched formats.

## ADDED Requirements

### Requirement: Caller selects the content representation

Page retrieval SHALL accept a `format` parameter with the values `markdown`, `storage`, and
`both`. When the parameter is omitted, retrieval SHALL behave as `both`.

#### Scenario: Markdown requested

- **WHEN** a page is retrieved with `format` set to `markdown`
- **THEN** the response includes the page content rendered as markdown
- **AND** the response does not include the raw storage content

#### Scenario: Storage requested

- **WHEN** a page is retrieved with `format` set to `storage`
- **THEN** the response includes the page's raw storage content exactly as returned by
  Confluence
- **AND** the response does not include a markdown rendering

#### Scenario: Both requested

- **WHEN** a page is retrieved with `format` set to `both`
- **THEN** the response includes both the markdown rendering and the raw storage content

#### Scenario: Format omitted

- **WHEN** a page is retrieved without a `format` parameter
- **THEN** the response includes both the markdown rendering and the raw storage content

#### Scenario: Invalid format rejected

- **WHEN** a page is retrieved with a `format` value other than `markdown`, `storage`, or `both`
- **THEN** an error is returned naming the parameter and listing the accepted values
- **AND** no page content is returned

### Requirement: Raw storage content is returned unmodified

When storage content is returned, it SHALL be byte-for-byte identical to what Confluence
supplied. It SHALL NOT be reformatted, re-indented, entity-normalized, or otherwise altered.

#### Scenario: Storage round-trips unchanged

- **WHEN** a page containing macros, layouts, and tables is retrieved with `format` set to
  `storage`
- **THEN** the returned storage content is identical to the page body Confluence returned

#### Scenario: Macros survive retrieval intact

- **WHEN** a page containing a structured macro is retrieved with `format` set to `storage`
- **THEN** the macro's markup and all of its parameters are present unchanged in the result

### Requirement: Retrieval reports the version needed to write

Every page retrieval SHALL return the page's current version number, so that a caller can
issue a conflict-detected write without a second request.

#### Scenario: Version accompanies content

- **WHEN** a page is retrieved in any format
- **THEN** the response includes the page's current version number

### Requirement: Markdown fidelity is disclosed on retrieval

When a markdown rendering is returned, the response SHALL indicate whether that rendering is a
lossy representation of the page, so a caller can tell whether writing back from the markdown
would discard content.

#### Scenario: Lossy page flagged

- **WHEN** a page containing a macro is retrieved with `format` set to `markdown` or `both`
- **THEN** the response indicates that the markdown rendering is lossy

#### Scenario: Faithful page not flagged

- **WHEN** a page containing only headings, paragraphs, and lists is retrieved with `format`
  set to `markdown` or `both`
- **THEN** the response indicates that the markdown rendering is not lossy

### Requirement: Retrieval exposes the page's section structure

Page retrieval SHALL report the headings present in the page, so a caller can identify a
section to edit without parsing the content itself.

#### Scenario: Headings listed

- **WHEN** a page containing multiple headings is retrieved
- **THEN** the response lists those headings in document order with their levels

#### Scenario: Duplicate headings distinguished

- **WHEN** a page contains more than one heading with identical text
- **THEN** each is listed separately with an occurrence index that distinguishes it
