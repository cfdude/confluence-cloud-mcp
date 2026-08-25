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

### Requirement: Markdown is returned under a stable key

The markdown rendering SHALL be returned under the response key `content`, unchanged from the
key used before this capability existed, so that a caller reading only markdown continues to
work without modification.

#### Scenario: Existing markdown consumer is unaffected

- **WHEN** a page is retrieved without a `format` parameter
- **THEN** the markdown rendering is present under the key `content`

#### Scenario: Storage is returned under its own key

- **WHEN** a page is retrieved with storage included
- **THEN** the raw storage is returned under a key distinct from `content`

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

### Requirement: Finding a page by title returns the same representations

Retrieving a page by title is a documented discovery path and SHALL offer the same `format`
parameter and return the same representations as retrieving one by id. It SHALL NOT discard
storage content the server has already fetched.

#### Scenario: Find by title returns storage

- **WHEN** a page is found by title with `format` set to `storage` or `both`
- **THEN** the response includes the raw storage content

#### Scenario: Find by title reports version and fidelity

- **WHEN** a page is found by title
- **THEN** the response includes the current version and the lossy indicator

#### Scenario: Listing pages is unaffected

- **WHEN** pages are listed for a space
- **THEN** the listing does not carry full page bodies

### Requirement: Retrieval exposes the page's section structure

Page retrieval SHALL report the headings present in the page, so a caller can identify a
section to edit without parsing the content itself.

#### Scenario: Headings listed

- **WHEN** a page containing multiple headings is retrieved
- **THEN** the response lists those headings in document order with their levels

#### Scenario: Duplicate headings distinguished

- **WHEN** a page contains more than one heading with identical text
- **THEN** each is listed separately with an occurrence index that distinguishes it

#### Scenario: Outline lists every heading with an addressability flag

- **WHEN** a page contains headings both inside and outside macro bodies or table cells
- **THEN** the outline lists every heading in document order
- **AND** each entry carries a flag stating whether it is addressable for section editing
- **AND** headings inside macro bodies or table cells are flagged as not addressable

#### Scenario: Page with no addressable headings is identifiable

- **WHEN** every heading on a page sits inside a macro body or table cell
- **THEN** the outline still lists those headings
- **AND** no entry is flagged addressable, allowing a caller to determine that section editing
  is unavailable before attempting it
