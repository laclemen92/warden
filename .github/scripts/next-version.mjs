// Pure helpers for the release-draft workflow. See docs/versioning.md.

export const SEMVER_LABELS = ['semver:major', 'semver:minor', 'semver:patch', 'semver:none'];

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(tag) {
  const m = VERSION.exec(tag);
  if (!m) throw new Error(`'${tag}' is not a version like v1.2.3 or v1.2.3-rc.1`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** The bump a PR's labels ask for, or null when it has none (or several) of the semver labels. */
export function bumpOf(labels) {
  const found = labels.filter((l) => SEMVER_LABELS.includes(l));
  return found.length === 1 ? found[0].slice('semver:'.length) : null;
}

/** The largest bump among PRs. A PR without exactly one semver label counts as patch. */
export function highestBump(prs) {
  let best = 'none';
  for (const pr of prs) {
    const bump = bumpOf(pr.labels) ?? 'patch';
    if (RANK[bump] > RANK[best]) best = bump;
  }
  return best;
}

/**
 * The version after `lastTag` for a bump. From a prerelease, a bump that the prerelease already
 * covers releases its version (v1.0.0-rc.1 + minor = 1.0.0), as `npm version` does.
 */
export function nextVersion(lastTag, bump) {
  const { major, minor, patch, pre } = parseVersion(lastTag);
  if (bump === 'none') return null;
  if (pre !== null) {
    if (bump === 'patch' || (bump === 'minor' && patch === 0) || (minor === 0 && patch === 0)) {
      return `${major}.${minor}.${patch}`;
    }
  }
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump '${bump}'`);
}

const UPGRADE_HEADING = /^#{2,3}\s*Breaking changes\s*\/\s*upgrade notes\s*$/im;
const EMPTY_NOTES = /^(none|n\/a|no|-|_none_|\*none\*)\.?$/i;

/** The PR template's "Breaking changes / upgrade notes" section, or null when it's empty or "None". */
export function upgradeNotes(body) {
  if (!body) return null;
  const text = body.replace(/\r\n/g, '\n');
  const start = UPGRADE_HEADING.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = /^#{1,3}\s/m.exec(rest);
  const section = (end ? rest.slice(0, end.index) : rest)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^Closes #\d+.*$/gim, '')
    .trim();
  return section === '' || EMPTY_NOTES.test(section) ? null : section;
}

export const DRAFT_MARKER = '<!-- warden-release-draft -->';

/** Markdown for the draft release that previews the next version. */
export function draftBody({ repo, lastTag, next, bump, prs, generatedNotes }) {
  const lines = [DRAFT_MARKER];
  if (next === null) {
    lines.push(
      `No release needed yet: nothing merged since \`${lastTag}\` changes Warden's public API or behaviour.`,
    );
  } else {
    lines.push(
      `**Suggested next version: \`v${next}\`** (${bump} bump since \`${lastTag}\`, from the \`semver:*\` labels of ${prs.length} merged PR${prs.length === 1 ? '' : 's'}).`,
      '',
      `This draft is a preview and is never published. To release, push the tag (\`git tag v${next} && git push origin v${next}\`); see [docs/releasing.md](https://github.com/${repo}/blob/main/docs/releasing.md).`,
    );
  }
  const unlabeled = prs.filter((pr) => bumpOf(pr.labels) === null);
  if (unlabeled.length > 0) {
    lines.push(
      '',
      `> [!WARNING]\n> Counted as patch because they lack exactly one \`semver:*\` label: ${unlabeled.map((pr) => `#${pr.number}`).join(', ')}. Label them and re-run **Release draft** if that's wrong.`,
    );
  }
  const notes = prs
    .map((pr) => ({ pr, notes: upgradeNotes(pr.body) }))
    .filter((n) => n.notes !== null);
  if (notes.length > 0) {
    lines.push('', '## Upgrade notes', '');
    for (const { pr, notes: text } of notes) {
      lines.push(`### ${pr.title} (#${pr.number})`, '', text, '');
    }
  }
  if (generatedNotes) lines.push('', generatedNotes);
  return lines.join('\n').trimEnd() + '\n';
}
