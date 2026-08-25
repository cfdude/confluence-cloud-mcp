/**
 * Every fixture through the new converter. Task 3.8.
 *
 * Two properties, asserted per fixture:
 *
 *   1. no output contains a `$1` token -- the corruption that reached live pages;
 *   2. no fixture loses text present in its source.
 *
 * The text-loss oracle is a word-set subset check. Words are extracted from the SOURCE's text
 * nodes with the real tokenizer, and every one of them must appear as a word in the markdown.
 * A substring check would pass on `eta` inside `theta`; splitting both sides into `[A-Za-z]+`
 * words avoids that, and survives entity decoding (`omega&rsquo;eta` yields `omega` and `eta`
 * on both sides).
 *
 * Two element interiors are excluded from the oracle, and only two: `ac:task-id` and
 * `ac:task-status`. Their text is a machine token (`7`, `complete`) that the renderer turns
 * into checkbox syntax rather than prose. Everything else -- including `ac:parameter`,
 * `ac:placeholder`, `ac:link-body`, `ac:rich-text-body` and `ac:plain-text-body` -- carries
 * reader-visible text and is held to the rule.
 */

import { describe, it, expect } from '@jest/globals';

import { listFixtureFiles, loadFixture } from './helpers/fixtures.js';
import { convertStorage } from '../src/utils/content-converter.js';
import { ancestorsOfToken, tokenize } from '../src/utils/storage-tokenizer.js';

/** Element interiors whose text is machine metadata rather than prose. */
const METADATA_ELEMENTS = new Set(['ac:task-id', 'ac:task-status']);

function words(text: string): string[] {
  return (text.match(/[A-Za-z]+/g) ?? []).map((word) => word.toLowerCase());
}

/** Alphabetic words in the source's reader-visible text nodes. */
function sourceWords(storage: string): string[] {
  const result = tokenize(storage);
  const collected: string[] = [];

  result.tokens.forEach((token, index) => {
    if (token.type !== 'text' && token.type !== 'cdata') return;
    const inMetadata = ancestorsOfToken(result, index).some((element) =>
      METADATA_ELEMENTS.has(element.name)
    );
    if (inMetadata) return;
    // Entity references are stripped rather than decoded: the source-side extractor must not
    // reimplement the converter's decoding, or it would stop being an independent check.
    collected.push(...words(token.raw.replace(/&#?\w+;/g, ' ')));
  });

  return collected;
}

const fixtures = listFixtureFiles();

describe('every fixture through the converter (task 3.8)', () => {
  it('finds fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
  });

  it.each(fixtures)('%s converts with no $1 token in the output', (name) => {
    const { markdown } = convertStorage(loadFixture(name));

    expect(markdown).not.toContain('$1');
    // The corruption signature the write path rejects (design.md D6) must not be producible
    // by the read path either.
    expect(markdown).not.toMatch(/[0-9]+\.\s*\$1(?![0-9])/);
  });

  it.each(fixtures)('%s loses no text present in its source', (name) => {
    const source = loadFixture(name);
    const { markdown } = convertStorage(source);
    const produced = new Set(words(markdown));

    const expected = [...new Set(sourceWords(source))];
    // Guard against a vacuous oracle: a fixture with no extractable words would pass trivially.
    expect({ name, wordCount: expected.length > 3 }).toEqual({ name, wordCount: true });

    const missing = expected.filter((word) => !produced.has(word));
    expect({ name, missing }).toEqual({ name, missing: [] });
  });

  it.each(fixtures)('%s converts without raising and reports a lossy indicator', (name) => {
    const result = convertStorage(loadFixture(name));

    expect(typeof result.markdown).toBe('string');
    expect(typeof result.lossy).toBe('boolean');
    expect(result.lossy).toBe(result.constructs.occurrences.length > 0);
  });
});
