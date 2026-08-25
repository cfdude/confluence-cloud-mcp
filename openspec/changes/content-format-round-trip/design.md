## Context

See proposal.md — Why, for motivation and the evidence behind the two converter defects.

Constraints that shape the approach:

- **Confluence v2 has no PATCH.** Every write replaces the whole page body. Section-scoped
  editing is therefore a server-side read-splice-write; the "section" boundary exists only in
  our code.
- **Storage format is XHTML with custom namespaced elements** (`ac:`, `ri:`). It is
  well-formed XML in practice, but it carries macro and app markup this server has no model
  for and must never need one for.
- **The current converter is a 20-stage chained regex pipeline** over the raw string
  (`src/utils/content-converter.ts`). Both known defects are direct consequences of that
  design: a function-replacement whose body was written as if it were a string replacement,
  and a whitespace-normalizing rule applied globally without structural awareness.
- **Atlassian's own guidance for programmatic editing** is to read storage, make targeted
  modifications, and preserve unknown macros verbatim — not to re-serialize whole documents.
- **The repository has one test file.** There is effectively no regression net today.
- **Two live pages carry corruption this change prevents recurring.** Repairing them is a
  separate change; this one must make the write path reject that content.

## Goals / Non-Goals

**Goals:**

- Reads never substitute, drop, or merge content, and disclose when markdown is lossy.
- An edit cannot damage content the caller did not target.
- A caller cannot silently rename a page or lose a concurrent edit.
- Fixtures that make converter fidelity a checked property rather than an assumption.

**Non-Goals:**

- **A faithful markdown → storage converter.** Markdown remains a read-only rendering. Writes
  are storage format. Attempting to author storage from markdown is the failure mode this
  change exists to remove, and building a "good enough" markdown writer would reintroduce it
  behind a friendlier interface.
- **Modelling macros.** Macros are opaque spans to be preserved, never parsed for meaning.
- **ADF.** Not lossless for macros, not recommended by Atlassian for programmatic editing, and
  removal of the unused `@atlaskit` packages belongs to `deps-security-sweep`.
- **Reformatting or normalizing storage.** The server is not a formatter.

## Decisions

### D1 — Two separate content pipelines, not one

The read path and the edit path have opposite requirements, and conflating them is the root
architectural error in the current code.

- **Read (storage → markdown)** may parse fully, because its output is markdown and nothing is
  ever written back from it.
- **Edit (storage → storage)** must never parse-and-re-serialize, because
  `page-section-editing` requires bytes outside the target section to be identical. Any
  re-serialization silently normalizes attribute order, entities, and self-closing tags across
  the whole document — including inside macros this server does not understand.

So the edit path uses a **scanner that reports source offsets**, and splices the original
string. Two pipelines, one shared tokenizer.

*Alternative considered:* a single parse → mutate → serialize pipeline. Rejected: it cannot
satisfy byte-for-byte preservation, and it puts every third-party macro on the page at the
mercy of our serializer.

### D2 — Replace the regex chain with a real tokenizer

The converter is rewritten over a tokenizer that emits an element/text/comment stream with
source offsets, rather than 20 sequential string rewrites. This is what makes nested lists,
tables, and lossy-detection expressible at all; the current pipeline cannot express nesting,
which is why its list handling degenerated.

The tokenizer must:
- preserve source offsets for every token (required by D1's edit path),
- pass through unknown and namespaced elements without interpretation,
- never throw on markup it does not recognize.

**Dependency choice:** add one small, actively maintained, zero-dependency parser rather than
hand-rolling a tokenizer. `parse5` is the default candidate — zero runtime dependencies, HTML5
spec-compliant, tracks source offsets via `sourceCodeLocationInfo`. A hand-rolled tokenizer is
the fallback if evaluation shows namespaced-element handling is unsuitable.

Net dependency effect is negative: this adds one small package while `deps-security-sweep`
removes three large ones.

*Alternatives considered:* (a) keep the regex chain and fix the two known defects — rejected,
it leaves nesting and lossy-detection unimplementable and the next defect equally likely;
(b) `cheerio`/`jsdom` — rejected as far heavier than needed and oriented to DOM manipulation
rather than offset-preserving scanning; (c) an XML parser — storage format is XHTML-like but
not reliably strict XML, so a lenient HTML5 parser fails more gracefully on real pages.

### D3 — Sections are located by offset, spliced as strings

Section resolution walks the token stream for heading elements and records, for each,
**three** offsets — not two:

| Offset | Meaning |
|---|---|
| `headingStart` | start of the heading's opening tag |
| `bodyStart` | end of the heading's closing tag (= start of the section body) |
| `sectionEnd` | `headingStart` of the next addressable heading at the same or higher level within the same sectioning container, or the container's end |

Two offsets are not enough, and conflating them is a correctness bug rather than a
simplification: `page-section-editing` guarantees that replacing a section **retains its
heading**, which is impossible if the replaced span begins at `headingStart`. Each operation
names the span it acts on explicitly:

| Operation | Span read | Span replaced / insertion point |
|---|---|---|
| replace-section | `bodyStart..sectionEnd` | replaced with the supplied content; heading untouched |
| append-to-section | `bodyStart..sectionEnd` | content inserted at `sectionEnd` |
| insert-section-after | — | new heading + body inserted at `sectionEnd` |

The edit is then `content.slice(0, spanStart) + newContent + content.slice(spanEnd)`. Nothing
outside `spanStart..spanEnd` is examined at all. That is what makes the byte-for-byte
guarantee real rather than aspirational, and why it extends to markup this server has never
seen.

**Sectioning containers and opaque regions.** A heading is *addressable* only if every
ancestor between it and the document root is a sectioning container. This is not a refinement;
without it the byte-for-byte guarantee is simply false on ordinary pages. Measured on the live
corpus:

| Nested-heading case | onvex, 340 pages | Highway, 3,602 pages |
|---|---|---|
| Heading inside `ac:rich-text-body` (a macro interior) | 5 | 275 |
| Heading inside a table cell | 0 | 499 |
| Heading inside `ac:layout-cell` | 3 | 239 |
| Pages where **every** heading sits in a layout cell | 3 | 238 |

Both naive rules fail on real data. Treating every `<h1>`–`<h6>` as addressable means a
heading inside an expand/panel/info macro truncates the enclosing section's extent early, so
an ordinary top-level replace splices at an offset *inside* `<ac:rich-text-body>`, orphaning
closing tags — on 275 Highway pages. Restricting to document-top-level only makes section
editing unusable on the 238 Highway pages whose every heading lives in a layout cell, which
are exactly the structured pages this change targets.

So the rule is asymmetric, by container kind:

- **`ac:layout` / `ac:layout-section` / `ac:layout-cell` are sectioning containers.** Headings
  inside them are addressable; a section's `sectionEnd` is clamped to its own cell's end, so a
  section never spans out of the cell that contains it.
- **`ac:rich-text-body` and any other macro interior is opaque.** Headings inside are neither
  addressable nor considered when computing another section's `sectionEnd` — they are
  invisible to the resolver, which is what keeps macro interiors unparsed per the Non-Goals.
- **Table cells are opaque**, on the same reasoning.

**Invariant:** `bodyStart` and `sectionEnd` must resolve to the same sectioning container. An
implementation that cannot assert this must fail the edit rather than splice.

Ambiguity is an error, not a heuristic: duplicate heading text without an occurrence index
fails and reports the match count, per spec. Guessing which of two identically-titled sections
the agent meant is precisely the class of silent damage this change is removing.

**Post-splice validation.** A fragment that is well-formed in isolation does not guarantee the
assembled document is, and a lenient HTML5 parser reparents stray tags rather than erroring.
The **assembled** document is therefore re-tokenized and validated before the write, and the
edit is rejected if assembly produced malformed storage. Validating only the caller's fragment
would let a subtly broken splice reach Confluence.

### D4 — Lossy detection by construct inventory

While tokenizing for conversion, collect the set of constructs markdown cannot represent —
`ac:structured-macro`, `ac:layout`, and any other `ac:`/`ri:` element. The conversion returns
that inventory alongside the markdown, and retrieval surfaces it.

This is deliberately conservative: any unrecognized namespaced element marks the render lossy.
Over-reporting costs an agent one extra `format: 'storage'` read; under-reporting costs a
destroyed page.

### D5 — Version resolved server-side, with opt-in conflict detection

Writes fetch the page's current version immediately before submitting and send `current + 1`.
The caller's arithmetic is removed from the protocol entirely.

`expectedVersion` is a separate, optional parameter with different semantics: when supplied and
not equal to the current version, the write fails. This distinction matters — resolving the
version is about *correctness* (the current code's off-by-one), while `expectedVersion` is
about *concurrency* (detecting someone else's edit). Conflating them is why the present API
requires a version yet provides no conflict safety.

Cost: one additional GET per write. Acceptable — a wrong version is a 409 and a retry anyway,
and page retrieval already returns the version, so an agent following the read-then-write flow
pays nothing extra.

*Alternative considered:* retry-on-409 with a re-read. Rejected as the primary mechanism: it
masks genuine concurrent edits as transient failures and would happily clobber another
author's change.

### D6 — Preflight checks compare against current page state

Whole-page writes are the escape hatch, so they get the checks section edits get for free:

1. **Well-formedness** — submitted content tokenizes cleanly.
2. **Markdown-as-storage detection** — see D8. Empirically the highest-value check.
3. **Conversion-artifact detection** — reject the `$1` corruption signature. Detection must
   cover **bare text**, not only `<li>` elements: on the one live page carrying the corruption,
   the storage body contains the literal text `1. $1  2. $1  3. $1  4. $1` with no list markup
   at all, because the agent pasted converted markdown straight into the storage field. A
   detector written only against `<li>` content would find nothing there.
   It must also stay structural rather than a substring search — the live scan found `$1.2M`,
   `$1K`, `$1,505,674`, and `$1::vector` in legitimate content, and a naive `includes('$1')`
   rejects all of them. The canonical signature is the scan regex `/[0-9]+\.\s*\$1(?![0-9])/`,
   which already discriminates correctly, plus the `<li>` whose entire text is `$1`.
4. **Construct-loss detection** — inventory macros and layouts in the current page and in the
   submission; if the submission drops any, reject and name them, unless the caller passes an
   explicit confirmation flag.

Check 4 is what stops macro loss on whole-page writes: an agent that read markdown, lost the
macros to the renderer, and submitted the result gets a specific, actionable error instead of
a silently gutted page.

**Construct-loss applies to section edits too, scoped to the replaced span.** Without this,
the specification would make editing a *whole page* safer than editing *one section* — an
agent that reads one section as lossy markdown and writes back "cleaned up" text, dropping a
macro embedded in that section, would be caught by nothing. Since spans are already
offset-delimited, the comparison is the existing inventory machinery run over
`bodyStart..sectionEnd` before and after. It is per-operation: replace-section compares the
span; append-to-section and insert-section-after remove nothing and skip the check.

### D8 — Reject markdown submitted as storage format

Measured on live data, this is the **most prevalent failure mode by a wide margin** and the
likeliest primary cause of "agents mess up the entire style and syntax of the page":

| Signal (code/preformatted regions excluded) | onvex, 340 pages | Highway, 3,602 pages |
|---|---|---|
| Markdown headings in storage | 6 | 12 |
| Markdown bullets in storage | 101 | 276 |
| Markdown bold in storage | 5 | 14 |
| **Any markdown-in-storage** | **102 (30.0%)** | **278 (7.7%)** |
| `N. $1` corruption | 1 | 1 |

Confirmed by inspection, not just pattern count — live pages contain
`## 🎯 Executive Summary` and `* **vs. LinkedIn/Indeed:** …` sitting in the storage field,
where Confluence renders the `##` and `*` as literal characters.

**Corrected measurement.** The percentages above were driven largely by a bare `-`/`*` bullet
test that has a high false-positive rate — humans routinely type a dash at the start of a line
in ordinary prose. Re-measured with the signals separated by confidence:

| Signal | onvex, 340 pages | Highway, 3,602 pages |
|---|---|---|
| Markdown heading `## X` | 6 | 12 |
| Markdown bold `**x**` | 5 | 14 |
| Fenced code block | 0 | 2 |
| Our macro-placeholder text `[Confluence Macro: …]` | 0 | 11 |
| `$1` artifact | 1 | 1 |
| **Pages with any high-confidence signal** | **6 (1.8%)** | **20 (0.6%)** |
| *Bare `-`/`*` bullets only (ambiguous)* | *96 (28.2%)* | *264 (7.3%)* |

So the true corruption count is **26 pages**, roughly 13× the `$1` bug — not the two orders of
magnitude an unseparated count suggested. The check is still worth having, and still a hard
rejection, but its **rule must exclude bare bullets**: rejecting them would false-positive on
360 pages of legitimate human-authored prose, which would make the server actively obstructive.

**Detection rule, final:** reject on markdown headings (`#` ×2–6 + space at line start),
`**` emphasis, triple-backtick fences, and our own `[Confluence Macro: …]` placeholder text —
all evaluated outside `<code>`, `<pre>`, `<ac:plain-text-body>`, and CDATA. A bare `-`/`*`
bullet is **not** on its own grounds for rejection; it counts only when the same submission
already trips one of the high-confidence signals.

The `[Confluence Macro: …]` placeholder deserves emphasis: it is this server's own converter
output, and its presence in submitted content is unambiguous proof of a lossy round trip. On
11 Highway pages a working table-of-contents macro has already been replaced by that literal
string, destroying page navigation.

Critically, **well-formedness validation cannot catch this**: `### Heading` and `- bullet` are
perfectly valid XHTML text nodes. It needs a distinct check for markdown structural syntax —
line-initial `#`, line-initial `-`/`*` followed by a space, `**` emphasis, and triple-backtick
fences — evaluated only outside `<code>`, `<pre>`, `<ac:plain-text-body>`, and CDATA, since
markdown inside a code block is legitimate content.

The rejection message is the important half. It must name the problem and the remedy —
"content appears to be markdown; supply Confluence storage format, or retrieve the page with
`format: 'storage'` to see what to author against" — because the error is the only channel
that reliably redirects an agent mid-task.

*Alternative considered:* silently converting submitted markdown to storage. Rejected — it
guesses at intent, cannot represent macros, and would quietly re-establish the lossy
markdown→storage path this change exists to eliminate. Rejecting with instructions keeps the
agent authoring the format the API actually stores.

*False-positive risk:* a page legitimately documenting markdown syntax in prose outside a code
block. Mitigated by a **dedicated override flag, distinct from the construct-removal
confirmation**. The two assertions are unrelated — "I meant to delete that macro" and "this
prose really does contain `**` " — and sharing one flag would let a caller confirm the wrong
thing. Excluding bare bullets from the rule removes the largest false-positive class outright.

### D10 — Check order

The preflight checks are ordered, because a mis-order masks the actionable error. Content
submitted as markdown contains no macros, so it also trips construct-loss detection; if that
ran first the agent would be told "you removed a macro" instead of "this is markdown, not
storage." Order: well-formedness → **markdown-as-storage** → conversion-artifact →
construct-loss.

### D11 — Coverage: every write path and every content-returning read path

Two handlers were initially overlooked and are in scope:

- **`find_confluence_page`** (`page-handlers.ts:156`) discards raw storage exactly as
  `get_confluence_page` does, and the client has already fetched it. It is a documented
  discovery path, so an agent following it still receives the lossy response this change
  exists to remove. It gets the same `format` parameter. `list_confluence_pages` is
  deliberately excluded — it should not carry full bodies.
- **`create_confluence_page`** (`page-handlers.ts:209`) passes content straight through with
  no validation at all. Creating a page from a markdown draft is the most natural authoring
  path for an agent, and a page created corrupted and never updated stays corrupted forever.
  Well-formedness, markdown-as-storage, and conversion-artifact checks all apply. Construct-loss
  does not — there is no prior version to compare against.

### D12 — Conflict error shape is uniform regardless of who detects it

D5 resolves the version by fetching immediately before the PUT, so a concurrent edit can still
land in the window between fetch and write. Atomicity there comes from Confluence rejecting
the mismatched version, not from our local check. Both paths — the local `expectedVersion`
comparison and Confluence's own rejection — SHALL surface the same conflict error shape, so a
caller has one case to handle and a test written against the local check does not silently
miss the race.

### D9 — Section edits require `expectedVersion`

D5 leaves `expectedVersion` optional for whole-page writes, which makes the default
last-write-wins. Section edits are different: the caller has necessarily just read the page in
order to name a section, so it already holds the version, and splicing into content that has
since changed can land an edit in the wrong place entirely. `expectedVersion` is therefore
**required** on the section-edit tools and optional on whole-page writes.

*Alternative considered:* making these warnings rather than errors. Rejected — agents
demonstrably act on returned content and not on advisory prose; the reported behavior is
agents "reporting `$1` as an error to be removed", i.e. reasoning about content rather than
heeding guidance. A rejection with a corrective message is the only feedback channel that
reliably changes what the agent does next.

### D7 — Retrieval response shape

`format` defaults to `'both'`, so the default response carries the markdown, the raw storage,
`version`, a `lossy` indicator, and the heading outline. This is an additive shape change to a
response that is already a JSON envelope.

The markdown stays under the existing key **`content`** — the key the handler uses today — so
a caller reading only markdown is unaffected. Raw storage is returned under a separate key
(`storage`). Naming the key here rather than leaving it to implementation makes the
compatibility guarantee checkable.

Returning both by default is the deliberate choice: it means an agent that does not know about
`format` still has the storage it needs to write back correctly, which is the failing case
today.

## Risks / Trade-offs

- **New parser dependency in a change motivated partly by dependency health** → Net removal of
  two packages once `deps-security-sweep` lands; the candidate has zero runtime dependencies;
  a hand-rolled tokenizer remains the fallback if evaluation disappoints.
- **Heading-based section addressing is fragile if a page has no headings, or uses styled
  paragraphs instead** → Whole-page writes remain fully supported as the escape hatch, and
  retrieval returns the heading outline so an agent can tell in advance whether section
  editing is usable on that page.
- **Byte-for-byte preservation is only as good as offset accuracy** → It is asserted directly
  in fixtures: splice a section on a macro-heavy fixture, then assert the surrounding regions
  are identical strings, not merely equivalent.
- **Construct-loss rejection may block legitimate deletions** → The explicit confirmation flag
  exists for exactly that, and the error names the specific constructs so the caller can decide.
- **Over-conservative lossy flagging may push agents to storage format more often than needed**
  → Intended. Storage is the correct input for a write; markdown is a reading convenience.
- **Rewriting the converter with almost no existing tests is where regressions hide** → The
  fixtures are built first and are a gating deliverable, not a trailing task. This is the
  reason for the task ordering rather than a general preference for TDD.
- **Fixtures captured from a live site would publish real page content** → This repository is
  **public**. Fixtures are captured from the `onvex` site only, never from `listreports`
  (Highway work product), and captured text is sanitized — real prose, names, figures, and
  URLs replaced with synthetic equivalents — while structural markup, macros, and layouts are
  preserved verbatim, since structure is the only thing the fixtures test. Where a shape can
  be hand-authored instead of captured, hand-author it.
- **The markdown-as-storage check could reject a page legitimately documenting markdown** →
  Accepted; see D8. Code and preformatted regions are excluded, and the confirmation flag
  provides an override.
- **`parse5` is HTML5-oriented and storage format is XHTML-like** → Evaluate against real
  macro- and layout-bearing fixtures captured from a live instance before committing to it;
  the fallback is scoped in the tasks.

## Migration Plan

1. Land fixtures and the tokenizer with the converter still in place, proving the new pipeline
   against captured real-world storage before anything switches over.
2. Switch the read path to the new converter; `format` defaults to `'both'`, so agents gain
   storage access at the same moment markdown becomes trustworthy.
3. Land write safety (title, version, preflight checks) — behavior-compatible for callers that
   already pass a title and a correct version.
4. Land section editing as new tools; nothing existing changes.

Rollback is per-step and independent. Steps 3 and 4 are additive; step 2 is the only one that
alters an existing response shape, and it is additive within that shape.

No data migration. The two corrupted live pages are repaired under `repair-corrupted-pages`,
after this change makes the write path reject that content.

## Open Questions

- Whether `parse5`'s handling of `ac:`-namespaced elements is faithful enough in practice, or
  whether the hand-rolled tokenizer fallback is needed. Deferrable: it changes the tokenizer's
  internals only. Both options satisfy every spec requirement, the offset contract in D1 is
  identical either way, and the fixtures decide it empirically in the first task.
- Whether section addressing should later accept an anchor or macro id in addition to heading
  text. Deferrable and purely additive; heading text covers the reported use cases.
