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
 * OUTPUT after the task 3.1 rewrite:
 *
 *     "Deployment steps:\n\n1. Open the console\n2. Click Deploy\n3. Verify the rollout"
 *
 * Two defects are visible in that one string: the `$1` substitution (this test), and the
 * global line-joining rule at content-converter.ts:~118 collapsing the three items onto one
 * line (NOT covered here -- task 3.3 must add its own test).
 *
 * STATUS: task 3.1 rewrote the converter over the storage token stream, so the assertions
 * below now hold and the `it.failing` marker has been REMOVED -- Jest hard-errors when a
 * `.failing` test passes, which is what forced the inversion. The assertions are unchanged
 * from the form task 1.4 pinned them in, and must not be loosened.
 *
 * The assertions are exactly the THEN clauses of the content-conversion spec scenario
 * "Ordered list converts with item text intact" -- nothing more, so that an unrelated
 * regression cannot keep this test red after 3.1.
 */

import { describe, it, expect } from '@jest/globals';

import { convertStorageToMarkdown } from '../src/utils/content-converter.js';
import { loadFixture } from './helpers/fixtures.js';

describe('ordered list conversion (task 1.4 defect fixture)', () => {
  // Guards the fixture path itself. While the test below was `it.failing`, a broken path
  // would have made it "pass" for the wrong reason; now it keeps a missing fixture from
  // being reported as a converter defect.
  it('the ordered-list fixture loads and contains an ordered list', () => {
    const storage = loadFixture('ordered-list');
    expect(storage.trim().length).toBeGreaterThan(0);
    expect(storage).toContain('<ol>');
    expect(storage).toContain('<li>Open the console</li>');
    expect(storage).toContain('<li>Click Deploy</li>');
  });

  it('preserves ordered-list item text and emits no $1 token', () => {
    const markdown = convertStorageToMarkdown(loadFixture('ordered-list'));

    expect(markdown).toContain('Open the console');
    expect(markdown).toContain('Click Deploy');
    expect(markdown).not.toContain('$1');
  });
});
