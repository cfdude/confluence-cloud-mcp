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

Section resolution walks the token stream for heading elements, records `(level, text,
startOffset, endOffset)`, and determines a section's extent as heading start → the start of
the next heading at the same or higher level, or end of document.

The edit is then `content.slice(0, start) + newSection + content.slice(end)`. Nothing between
`0` and `start`, or between `end` and the end of the document, is examined at all. That is
what makes the byte-for-byte guarantee real rather than aspirational, and it is why the
guarantee extends to markup this server has never seen.

Ambiguity is an error, not a heuristic: duplicate heading text without an occurrence index
fails and reports the match count, per spec. Guessing which of two identically-titled sections
the agent meant is precisely the class of silent damage this change is removing.

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
2. **Conversion-artifact detection** — reject list items whose *entire* text content is the
   token `$1`. Structural, not a substring search: the live-data scan found `$1.2M`, `$1K`,
   and `$1::vector` in legitimate page content, and a naive `includes('$1')` would reject all
   of them. The corruption signature is a list item that contains nothing else.
3. **Construct-loss detection** — inventory macros and layouts in the current page and in the
   submission; if the submission drops any, reject and name them, unless the caller passes an
   explicit confirmation flag.

Check 3 is what actually stops the reported failure mode for whole-page writes: an agent that
read markdown, lost the macros to the renderer, and submitted the result gets a specific,
actionable error instead of a silently gutted page.

*Alternative considered:* making these warnings rather than errors. Rejected — agents
demonstrably act on returned content and not on advisory prose; the reported behavior is
agents "reporting `$1` as an error to be removed", i.e. reasoning about content rather than
heeding guidance. A rejection with a corrective message is the only feedback channel that
reliably changes what the agent does next.

### D7 — Retrieval response shape

`format` defaults to `'both'`, so the default response carries `markdown`, `storage`, `version`,
a `lossy` indicator, and the heading outline. This is an additive shape change to a response
that is already a JSON envelope; the markdown remains present under a stable key so a caller
reading only markdown continues to work.

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
