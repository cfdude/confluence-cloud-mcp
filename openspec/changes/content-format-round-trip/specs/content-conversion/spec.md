## Purpose

Converts Confluence storage format into readable markdown for AI agents, guaranteeing that
the conversion never silently substitutes, drops, or merges content — and that anything it
cannot faithfully represent is marked as lossy rather than presented as complete.

## ADDED Requirements

### Requirement: Ordered list items retain their text

The conversion SHALL preserve the text content of every ordered list item. It SHALL NOT emit
regular-expression capture-group placeholders (such as the literal characters `$1`) in place
of item content.

#### Scenario: Ordered list converts with item text intact

- **WHEN** storage content `<ol><li>Open the console</li><li>Click Deploy</li></ol>` is converted
- **THEN** the result contains the text `Open the console` and the text `Click Deploy`
- **AND** the result contains no occurrence of the literal token `$1`

#### Scenario: Ordered list items are sequentially numbered

- **WHEN** storage content containing an ordered list of three items is converted
- **THEN** the items are numbered `1.`, `2.`, and `3.` in document order

#### Scenario: Inline markup inside an ordered list item is preserved

- **WHEN** an ordered list item contains `<strong>Deploy</strong>`
- **THEN** the converted item text contains the emphasized word `Deploy`
- **AND** the item's surrounding text is not discarded

### Requirement: List structure survives conversion

The conversion SHALL place each list item on its own line. It SHALL NOT join separate list
items onto a single line.

#### Scenario: Ordered list items are line-separated

- **WHEN** storage content containing an ordered list of three items is converted
- **THEN** each numbered item appears on a separate line

#### Scenario: Unordered list items are line-separated

- **WHEN** storage content `<ul><li>note A</li><li>note B</li></ul>` is converted
- **THEN** `note A` and `note B` appear on separate lines

#### Scenario: Nested lists preserve their nesting

- **WHEN** storage content containing a list nested inside another list item is converted
- **THEN** the nested items are indented relative to their parent item
- **AND** no nested item's text is lost

### Requirement: Conversion is non-destructive for text content

The conversion SHALL NOT discard the text content of any element it processes. Where the
conversion encounters a construct it does not model, it SHALL retain that construct's
human-readable text rather than dropping the element.

#### Scenario: Table cell text is preserved

- **WHEN** storage content containing a table with header and body cells is converted
- **THEN** the text of every cell appears in the result

#### Scenario: Unrecognized element retains its text

- **WHEN** storage content contains an element the converter does not explicitly handle
- **THEN** the text inside that element appears in the result

### Requirement: Lossy conversion is disclosed

Markdown produced by the conversion is a lossy rendering of the source. The conversion SHALL
report whether the source contained constructs — including macros and layouts — that the
markdown does not faithfully represent, so that a caller can determine whether the markdown is
safe to use as the basis for a write.

#### Scenario: Page containing a macro is reported as lossy

- **WHEN** storage content containing a structured macro is converted
- **THEN** the conversion reports that the result is lossy
- **AND** identifies that a macro was among the constructs not faithfully represented

#### Scenario: Page containing a layout is reported as lossy

- **WHEN** storage content containing a layout is converted
- **THEN** the conversion reports that the result is lossy

#### Scenario: Plain page is reported as faithful

- **WHEN** storage content containing only headings, paragraphs, lists, and inline emphasis is
  converted
- **THEN** the conversion reports that the result is not lossy

### Requirement: Conversion failure is surfaced, not silently substituted

The conversion SHALL NOT return partially converted output as though it were complete. If the
conversion cannot complete, it SHALL raise an error identifying the failure.

#### Scenario: Malformed source raises an error

- **WHEN** conversion of a given input cannot complete
- **THEN** an error is raised describing the failure
- **AND** no partial or placeholder-substituted result is returned as a success
