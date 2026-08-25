/**
 * Task 1.4 -- the fixture that detects the reported defect.
 *
 * Reported defect: `src/utils/content-converter.ts` passes a FUNCTION to `String.replace`
 * whose body is written as if it were a string replacement. With a function replacement
 * `$1` has no special meaning, so the literal characters are emitted and every ordered-list
 * item's text is destroyed.
 *
 * OBSERVED OUTPUT of `convertStorageToMarkdown(loadFixture('ordered-list'))` against the
 * converter as it stands (captured 2026-08-25, before any converter change):
 *
 *     "Deployment steps:\n\n1. $1 2. $1 3. $1"
 *
 * Two defects are visible in that one string: the `$1` substitution (this test), and the
 * global line-joining rule at content-converter.ts:~118 collapsing the three items onto one
 * line (NOT covered here -- task 3.3 must add its own test).
 *
 * WHY `it.failing`: the deliverable requires a test that fails against the current converter,
 * while `npm test` has to stay usable overall. `it.failing` runs the assertions and passes
 * the suite only while they fail -- and turns into a hard failure the moment they start
 * passing. So when task 3.1 fixes the converter, this test breaks and forces the `.failing`
 * marker to be removed, which is exactly the inversion task 3.1 asks for. The assertions
 * below are written in their FINAL, correct form and must not be loosened.
 *
 * The assertions are exactly the THEN clauses of the content-conversion spec scenario
 * "Ordered list converts with item text intact" -- nothing more, so that an unrelated
 * regression cannot keep this test red after 3.1.
 */

import { describe, it, expect } from '@jest/globals';

import { convertStorageToMarkdown } from '../src/utils/content-converter.js';
import { loadFixture } from './helpers/fixtures.js';

describe('ordered list conversion (task 1.4 defect fixture)', () => {
  // Genuinely green. Without this, a broken fixture path would make the `it.failing` below
  // "pass" for the wrong reason -- a throw is indistinguishable from a detected defect.
  it('the ordered-list fixture loads and contains an ordered list', () => {
    const storage = loadFixture('ordered-list');
    expect(storage.trim().length).toBeGreaterThan(0);
    expect(storage).toContain('<ol>');
    expect(storage).toContain('<li>Open the console</li>');
    expect(storage).toContain('<li>Click Deploy</li>');
  });

  // NOTE: remove `.failing` in task 3.1 once the converter is fixed (see WHY above).
  it.failing('preserves ordered-list item text and emits no $1 token', () => {
    const markdown = convertStorageToMarkdown(loadFixture('ordered-list'));

    expect(markdown).toContain('Open the console');
    expect(markdown).toContain('Click Deploy');
    expect(markdown).not.toContain('$1');
  });
});
