/**
 * Lossy disclosure and construct inventory returned from the conversion. Task 3.6, design.md D4.
 *
 * Also asserts the reconciliation between the renderer's explicit element coverage and
 * `MODELLED_ELEMENTS` in storage-constructs.ts. That set is a promise: if the renderer dropped
 * an element the set calls modelled, `unknownNames` would under-report it and `lossy` would
 * claim "faithful" for a page that had just lost content. The two are checked against each
 * other here rather than maintained independently.
 */

import { describe, it, expect } from '@jest/globals';

import { convertStorage, reconcileModelledElements } from '../src/utils/content-converter.js';
import { MODELLED_ELEMENTS } from '../src/utils/storage-constructs.js';
import { loadFixture } from './helpers/fixtures.js';

describe('lossy disclosure (task 3.6)', () => {
  it('reports a page containing a structured macro as lossy and names the macro', () => {
    const result = convertStorage(loadFixture('macro-in-list'));

    expect(result.lossy).toBe(true);
    expect(result.constructs.macroNames).toEqual(expect.arrayContaining(['info', 'status']));
    expect(result.constructs.occurrences.some((o) => o.category === 'macro')).toBe(true);
  });

  it('reports a page containing a layout as lossy and names the layout elements', () => {
    const result = convertStorage(loadFixture('heading-in-layout-cells'));

    expect(result.lossy).toBe(true);
    expect(result.constructs.layoutNames).toEqual(
      expect.arrayContaining(['ac:layout', 'ac:layout-cell', 'ac:layout-section'])
    );
  });

  it('reports a plain page as faithful', () => {
    const result = convertStorage(loadFixture('plain'));

    expect(result.lossy).toBe(false);
    expect(result.constructs.occurrences).toHaveLength(0);
    expect(result.markdown).toContain('# Release Notes');
  });

  it('reports a plain HTML table as faithful -- a table is neither macro nor layout', () => {
    expect(convertStorage(loadFixture('table')).lossy).toBe(false);
    expect(convertStorage(loadFixture('heading-in-table-cell')).lossy).toBe(false);
  });

  it('reports an unmodelled non-namespaced element as lossy and names it', () => {
    const result = convertStorage(loadFixture('unknown-markup'));

    expect(result.lossy).toBe(true);
    expect(result.constructs.unknownNames).toContain('x-widget');
  });

  it('returns the markdown alongside the indicator, not instead of it', () => {
    const result = convertStorage(loadFixture('ordered-list'));

    expect(result.markdown).toContain('1. Open the console');
    expect(result.lossy).toBe(false);
    expect(result.constructs.signatures).toEqual([]);
  });
});

describe('MODELLED_ELEMENTS is reconciled with the renderer', () => {
  it('has an explicit renderer for every element the inventory calls modelled', () => {
    expect(reconcileModelledElements().unhandled).toEqual([]);
  });

  it('declares every non-namespaced element the renderer handles as modelled', () => {
    expect(reconcileModelledElements().undeclared).toEqual([]);
  });

  it('keeps a modelled element out of the lossy inventory', () => {
    for (const name of MODELLED_ELEMENTS) {
      if (name === 'br' || name === 'hr' || name === 'img' || name === 'col') continue;
      const result = convertStorage(`<${name}>text</${name}>`);
      expect({ name, lossy: result.lossy }).toEqual({ name, lossy: false });
      expect({ name, markdown: result.markdown }).toEqual(
        expect.objectContaining({ name, markdown: expect.stringContaining('text') })
      );
    }
  });
});
