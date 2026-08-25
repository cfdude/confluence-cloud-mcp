/**
 * Conversion failure is surfaced, not silently substituted. Task 3.7.
 *
 * The old converter caught everything, logged, and threw a bare
 * `new Error('Failed to convert content to markdown')` with the cause discarded. The spec
 * requires the cause to travel with the error, and requires that no partially converted
 * result is ever handed back as a success.
 *
 * The spec is deliberately narrow about what counts as a failure: unrecognized or MALFORMED
 * markup is NOT one -- that is text retention, covered in content-converter.test.ts. The
 * failure cases are an absent input and an injected internal failure.
 *
 * Injection is done with `jest.spyOn(internals, 'tokenize')`. ESM module mocking is not
 * available in this harness -- `jest.unstable_mockModule` is a no-op here, verified before
 * choosing this route -- so the converter routes its tokenizer and inventory calls through an
 * exported `internals` object instead of taking a test-only parameter.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';

import {
  convertStorage,
  convertStorageToMarkdown,
  internals,
} from '../src/utils/content-converter.js';
import { loadFixture } from './helpers/fixtures.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('absent input raises (task 3.7)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('raises on %s input, identifying the invalid input', (label, value) => {
    expect(() => convertStorage(value as unknown as string)).toThrow(TypeError);
    expect(() => convertStorage(value as unknown as string)).toThrow(
      new RegExp(`storage-format string, received ${label}`)
    );
  });

  it('raises on a non-string input rather than converting it', () => {
    expect(() => convertStorage(42 as unknown as string)).toThrow(/received number/);
    expect(() => convertStorageToMarkdown({} as unknown as string)).toThrow(/received object/);
  });

  it('returns nothing at all on an absent input -- no empty-string success', () => {
    let returned: unknown = 'sentinel';
    try {
      returned = convertStorage(undefined as unknown as string);
    } catch {
      // expected
    }
    expect(returned).toBe('sentinel');
  });
});

describe('injected internal failure propagates with its cause (task 3.7)', () => {
  it('carries the originating cause on the raised error', () => {
    const injected = new Error('injected tokenizer failure');
    jest.spyOn(internals, 'tokenize').mockImplementation(() => {
      throw injected;
    });

    let caught: unknown;
    try {
      convertStorage(loadFixture('ordered-list'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Failed to convert Confluence storage format/);
    expect((caught as Error).cause).toBe(injected);
  });

  it('returns no partial or placeholder-substituted result when the inventory fails', () => {
    const injected = new Error('injected inventory failure');
    jest.spyOn(internals, 'collectConstructs').mockImplementation(() => {
      throw injected;
    });

    let returned: unknown = 'sentinel';
    let caught: unknown;
    try {
      returned = convertStorageToMarkdown(loadFixture('macro-in-list'));
    } catch (error) {
      caught = error;
    }

    expect(returned).toBe('sentinel');
    expect((caught as Error).cause).toBe(injected);
  });

  it('does not swallow the failure into an empty conversion', () => {
    jest.spyOn(internals, 'tokenize').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => convertStorageToMarkdown('<p>x</p>')).toThrow();
  });
});

describe('unrecognized markup does not raise (task 3.7)', () => {
  it.each([
    ['unknown element', '<x-widget>text</x-widget>'],
    ['unclosed element', '<p>text'],
    ['stray close tag', 'text</p>'],
    ['bare less-than in prose', '<p>3 < 4 is true</p>'],
    ['unterminated tag', '<p class="x'],
    ['unterminated comment', '<p>a</p><!-- open'],
    ['empty string', ''],
  ])('returns a result for %s without raising', (_label, source) => {
    const result = convertStorage(source);
    expect(typeof result.markdown).toBe('string');
    expect(result).toHaveProperty('lossy');
  });

  it('returns a result for every fixture, however unusual its markup', () => {
    for (const name of ['unknown-markup', 'captured-layout-table-macros']) {
      expect(() => convertStorage(loadFixture(name))).not.toThrow();
    }
  });
});
