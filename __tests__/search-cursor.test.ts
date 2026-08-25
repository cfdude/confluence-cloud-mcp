import { extractCursor } from '../src/handlers/search-label-handlers.js';

/**
 * Regression test for a live defect: `search_confluence_pages` returned results from the API
 * and then threw `Invalid URL` while post-processing them, so every search failed.
 *
 * Cause: the v1 search API returns `_links.next` as a RELATIVE path, and `new URL()` with no
 * base throws on a relative string.
 */
describe('extractCursor', () => {
  it('reads a cursor from the relative link the v1 search API actually returns', () => {
    expect(extractCursor('/rest/api/search?cql=type%3Dpage&cursor=abc123&limit=25')).toBe('abc123');
  });

  it('does not throw on a relative link without a cursor', () => {
    expect(extractCursor('/rest/api/search?cql=type%3Dpage&start=5')).toBeUndefined();
  });

  it('still handles an absolute link', () => {
    expect(extractCursor('https://example.atlassian.net/wiki/rest/api/search?cursor=xyz')).toBe(
      'xyz'
    );
  });

  it('returns undefined rather than throwing on an unparseable link', () => {
    expect(extractCursor('://not a url')).toBeUndefined();
  });

  it.each([undefined, null, ''])('returns undefined for %p', (value) => {
    expect(extractCursor(value as string | undefined | null)).toBeUndefined();
  });
});
