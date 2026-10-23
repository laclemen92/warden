// Run with `node --test .github/scripts/*.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpOf, draftBody, highestBump, nextVersion, upgradeNotes } from './next-version.mjs';

test('bumps a stable version', () => {
  assert.equal(nextVersion('v1.4.2', 'patch'), '1.4.3');
  assert.equal(nextVersion('v1.4.2', 'minor'), '1.5.0');
  assert.equal(nextVersion('v1.4.2', 'major'), '2.0.0');
  assert.equal(nextVersion('v1.4.2', 'none'), null);
});

test('releases a prerelease when the bump is already covered by it', () => {
  for (const bump of ['patch', 'minor', 'major']) {
    assert.equal(nextVersion('v1.0.0-rc.1', bump), '1.0.0');
  }
  assert.equal(nextVersion('v1.2.0-rc.1', 'minor'), '1.2.0');
  assert.equal(nextVersion('v1.2.0-rc.1', 'major'), '2.0.0');
  assert.equal(nextVersion('v1.2.3-rc.1', 'patch'), '1.2.3');
  assert.equal(nextVersion('v1.2.3-rc.1', 'minor'), '1.3.0');
  assert.equal(nextVersion('v1.0.0-rc.1', 'none'), null);
});

test('rejects a tag that is not a version', () => {
  assert.throws(() => nextVersion('release-1', 'patch'));
  assert.throws(() => nextVersion('v01.2.3', 'patch'));
});

test('reads exactly one semver label', () => {
  assert.equal(bumpOf(['area:web', 'semver:minor']), 'minor');
  assert.equal(bumpOf(['area:web']), null);
  assert.equal(bumpOf(['semver:minor', 'semver:patch']), null);
});

test('takes the highest bump, counting unlabeled PRs as patch', () => {
  assert.equal(highestBump([]), 'none');
  assert.equal(highestBump([{ labels: ['semver:none'] }]), 'none');
  assert.equal(highestBump([{ labels: ['semver:none'] }, { labels: [] }]), 'patch');
  assert.equal(
    highestBump([
      { labels: ['semver:patch'] },
      { labels: ['semver:major'] },
      { labels: ['semver:minor'] },
    ]),
    'major',
  );
});

const template = (notes) =>
  `## Summary\n\nStuff.\n\n## Breaking changes / upgrade notes\n\n<!-- Required for semver:major. -->\n${notes}\n\n## Test plan\n\n- tests\n\nCloses #1\n`;

test('extracts upgrade notes from a PR body', () => {
  assert.equal(
    upgradeNotes(template('Rename `foo` to `bar` in config.')),
    'Rename `foo` to `bar` in config.',
  );
  assert.equal(upgradeNotes(template('None')), null);
  assert.equal(upgradeNotes(template('None.')), null);
  assert.equal(upgradeNotes(template('')), null);
  assert.equal(upgradeNotes('## Summary\n\nNo template.'), null);
  assert.equal(upgradeNotes(null), null);
  assert.equal(
    upgradeNotes('## Breaking changes / upgrade notes\r\n\r\nRe-run the grants.\r\n\r\nCloses #2'),
    'Re-run the grants.',
  );
});

test('keeps headings inside code fences in upgrade notes', () => {
  const notes =
    'Re-run the grants:\n\n```sh\n# as the owner role\npsql -f grants.sql\n```\n\n~~~sql\n## not a heading\n~~~';
  assert.equal(upgradeNotes(template(notes)), notes);
});

test('builds the draft body', () => {
  const body = draftBody({
    repo: 'o/r',
    lastTag: 'v1.0.0',
    next: '2.0.0',
    bump: 'major',
    prs: [
      { number: 5, title: 'Rename foo', labels: ['semver:major'], body: template('Rename foo.') },
      { number: 6, title: 'Old PR', labels: [], body: '' },
    ],
    generatedNotes: '## What changed',
  });
  assert.match(body, /Suggested next version: `v2\.0\.0`/);
  assert.match(body, /git tag v2\.0\.0/);
  assert.match(body, /lack exactly one `semver:\*` label: #6/);
  assert.match(body, /## Upgrade notes\n\n### Rename foo \(#5\)\n\nRename foo\./);
  assert.ok(body.endsWith('## What changed\n'));

  const empty = draftBody({ repo: 'o/r', lastTag: 'v1.0.0', next: null, bump: 'none', prs: [] });
  assert.match(empty, /No release needed yet/);
});
