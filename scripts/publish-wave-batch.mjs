#!/usr/bin/env node
/**
 * Publish a drafted Wave batch as GitHub issues.
 *
 * The drafts are plain Markdown (scripts/wave-issues-*.md) so they can be
 * reviewed in a PR before anything reaches contributors. This turns one into
 * issues, exactly as the earlier batches were published:
 *
 *   - title      the text after "### V131 · "
 *   - labels     the "**Labels:**" line, plus points:N read from the Drips line
 *   - body       everything else, with the contributor Telegram footer appended
 *
 * Missing labels are created rather than silently dropped — GitHub ignores
 * unknown labels on issue creation, which is how a batch ends up unpointed and
 * therefore unpaid.
 *
 *   node scripts/publish-wave-batch.mjs scripts/wave-issues-privacy.md --repo Miracle656/veil
 *   node scripts/publish-wave-batch.mjs scripts/wave-issues-privacy.md --repo Miracle656/veil --publish
 *
 * Without --publish it prints what it would do and changes nothing.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TELEGRAM_FOOTER =
  '\n\n---\n\n**Required:** Before submitting, join the contributor Telegram so your work ' +
  'can be tracked and counted toward the Stellar Wave: https://t.me/+fxHXq8f1SwlkZDBk\n'

/** Colours for labels this script may have to create. */
const LABEL_COLOURS = {
  'points:100': '0E8A16',
  'points:150': 'FBCA04',
  'points:200': 'D93F0B',
  'Stellar Wave': 'FDDA24',
  'help wanted': '008672',
  'difficulty:easy': 'C2E0C6',
  'difficulty:intermediate': 'FBCA04',
  'difficulty:advanced': 'D93F0B',
}

function gh(args, { json = false } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return json ? JSON.parse(out || 'null') : out
}

/** Every issue in a draft file. */
export function parseBatch(markdown) {
  const issues = []
  // Sections look like "### V131 · Privacy feature flag and SPP network config".
  const parts = markdown.split(/^### (V\d+) · (.+)$/m)
  for (let i = 1; i < parts.length; i += 3) {
    const [id, title, rest] = [parts[i], parts[i + 1].trim(), parts[i + 2]]
    const labels = (rest.match(/^\*\*Labels:\*\*\s*(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean)
    const points = rest.match(/\*\*(\d+) points\*\*/)?.[1]
    if (points) labels.push(`points:${points}`)

    // Body: everything after the Labels line, minus the trailing rule.
    const body = rest
      .replace(/^\*\*Labels:\*\*.*$/m, '')
      .replace(/\n---\s*$/, '')
      .trim()
    issues.push({ id, title, labels: [...new Set(labels)], points: Number(points ?? 0), body })
  }
  return issues
}

function ensureLabels(repo, labels) {
  const existing = new Set(
    gh(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name'], { json: true }).map(
      (l) => l.name,
    ),
  )
  const missing = labels.filter((l) => !existing.has(l))
  for (const label of missing) {
    const colour = LABEL_COLOURS[label] ?? 'BFD4F2'
    gh(['label', 'create', label, '-R', repo, '--color', colour, '--description', 'Wave batch'])
    console.log(`  created label ${label}`)
  }
  return missing
}

function main() {
  const [file, ...rest] = process.argv.slice(2)
  const repo = rest[rest.indexOf('--repo') + 1]
  const publish = rest.includes('--publish')
  if (!file || !repo || rest.indexOf('--repo') === -1) {
    console.error('usage: publish-wave-batch.mjs <draft.md> --repo owner/name [--publish]')
    process.exit(1)
  }

  const issues = parseBatch(readFileSync(file, 'utf8'))
  const points = issues.reduce((n, i) => n + i.points, 0)
  console.log(`${file} → ${repo}: ${issues.length} issues, ${points} points\n`)

  const unpointed = issues.filter((i) => !i.points)
  if (unpointed.length) {
    console.error(`REFUSING: ${unpointed.length} issue(s) have no points line: ${unpointed.map((i) => i.id).join(', ')}`)
    process.exit(1)
  }

  if (!publish) {
    for (const i of issues) console.log(`  ${i.id} [${i.points}] ${i.title}\n      ${i.labels.join(', ')}`)
    console.log('\nDry run. Re-run with --publish to create these issues.')
    return
  }

  ensureLabels(repo, [...new Set(issues.flatMap((i) => i.labels))])

  for (const issue of issues) {
    const args = ['issue', 'create', '-R', repo, '--title', issue.title, '--body', issue.body + TELEGRAM_FOOTER]
    for (const label of issue.labels) args.push('--label', label)
    const url = gh(args).trim().split('\n').pop()
    console.log(`  ${issue.id} [${issue.points}] ${url}`)
  }
}

// Run only when invoked directly. pathToFileURL, because a Windows path does
// not become a file:// URL by string concatenation.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
