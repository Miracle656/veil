#!/usr/bin/env node
/**
 * Build the Veil Masquerade token metadata from `brand/veil-masquerade/traits.json`.
 *
 * One JSON per token in the shape the wallet already parses — `name`,
 * `description`, `image`, `attributes: [{ trait_type, value }]`
 * (`frontend/wallet/lib/nfts.ts`, CAP-46). That is also the shape marketplaces
 * and indexers expect, so nothing here is Veil-specific.
 *
 * Generated rather than hand-written for two reasons: twenty files edited by
 * hand drift, and rarity has to be COUNTED. A "1 of 20" written by hand is a
 * claim; counted from the trait table it is a fact, and if a trait is edited
 * the counts move with it.
 *
 *   node scripts/build-nft-metadata.mjs            # write the files
 *   node scripts/build-nft-metadata.mjs --check    # fail if they are stale
 *
 * The `image` field is a placeholder until the art is final — see
 * `brand/veil-masquerade/README.md`. Nothing is minted from this yet.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const collectionDir = join(repoRoot, 'brand', 'veil-masquerade')
const metadataDir = join(collectionDir, 'metadata')

/**
 * Where the images will live once they exist.
 *
 * Deliberately an obvious placeholder, not a guessed URL: metadata that points
 * at a plausible-looking address nobody has uploaded to is worse than metadata
 * that admits it is unfinished, because the first kind mints.
 */
const IMAGE_BASE = 'ipfs://REPLACE_WITH_COLLECTION_CID'

const TRAIT_FIELDS = [
  ['Crown', 'crown'],
  ['Aperture', 'aperture'],
  ['Ornament', 'ornament'],
  ['Palette', 'palette'],
  ['Hem', 'hem'],
]

function pad(id) {
  return String(id).padStart(2, '0')
}

/** How many tokens share each value of each trait. */
export function countTraits(tokens) {
  const counts = {}
  for (const [label, field] of TRAIT_FIELDS) {
    counts[label] = {}
    for (const token of tokens) {
      const value = token[field]
      counts[label][value] = (counts[label][value] ?? 0) + 1
    }
  }
  return counts
}

/**
 * The metadata document for one token.
 *
 * `trait_type` / `value` is the convention the wallet reads. The rarity of each
 * trait goes in as a plain sentence in the description rather than a numeric
 * "score": a score implies a market ranking nobody has agreed, while "1 of 20"
 * is just true.
 */
/**
 * How a token's rarest shared trait reads.
 *
 * Phrased three ways because "shared with 0 others" is what a single template
 * produces for the one-of-one, and that sentence undersells the only token in
 * the set with no aperture at all.
 */
function rarityLine(rarest, total) {
  const trait = rarest.label.toLowerCase()
  if (rarest.count === 1) return `Its ${trait} is the only one of its kind in the set of ${total}.`
  if (rarest.count === 2) return `Its ${trait} is shared with one other in the set of ${total}.`
  return `Its ${trait} is shared with ${rarest.count - 1} others in the set of ${total}.`
}

export function buildToken(token, counts, total, rarityTraits) {
  const attributes = TRAIT_FIELDS.map(([label, field]) => ({
    trait_type: label,
    value: token[field],
  }))

  // Rarity is only read off the SHARED traits. Every Crown in the set is
  // unique, so "1 of 20" on a crown reads as significant and means nothing —
  // it is what makes the figure itself, not what makes it rare.
  const rarest = TRAIT_FIELDS.filter(([label]) => rarityTraits.includes(label))
    .map(([label, field]) => ({ label, value: token[field], count: counts[label][token[field]] }))
    .sort((a, b) => a.count - b.count || a.label.localeCompare(b.label))[0]

  const traitSentence = TRAIT_FIELDS.map(([label, field]) => `${label}: ${token[field]}.`).join(' ')

  return {
    name: `Veil Masquerade #${pad(token.id)}`,
    description:
      `A cloth figure for Veil: a crowned mask over layered, patterned cloth falling to an uneven hem. ` +
      `${traitSentence} ` +
      `${rarityLine(rarest, total)} ` +
      `No face — where the cloth is open, it is cloth removed rather than features drawn on.`,
    image: `${IMAGE_BASE}/${pad(token.id)}.png`,
    external_url: 'https://useveilapp.xyz',
    attributes,
  }
}

function buildCollection(source, counts) {
  const { collection } = source
  return {
    name: collection.name,
    symbol: collection.symbol,
    description: collection.description,
    external_url: collection.externalUrl,
    image: `${IMAGE_BASE}/cover.png`,
    total_supply: source.tokens.length,
    /** Counted from the trait table, never asserted. */
    trait_counts: counts,
  }
}

function main() {
  const check = process.argv.includes('--check')
  const source = JSON.parse(readFileSync(join(collectionDir, 'traits.json'), 'utf8'))
  const { tokens } = source

  if (tokens.length !== source.collection.size) {
    throw new Error(
      `traits.json says the collection is ${source.collection.size} but lists ${tokens.length} tokens`,
    )
  }

  const ids = new Set(tokens.map((t) => t.id))
  if (ids.size !== tokens.length) throw new Error('traits.json has a duplicate token id')

  const counts = countTraits(tokens)
  const rarityTraits = source.rarityTraits ?? TRAIT_FIELDS.map(([label]) => label)

  // A trait declared as carrying rarity but unique on every token would make
  // every description claim a one-of-one. Catch it here rather than in the copy.
  for (const label of rarityTraits) {
    const values = Object.values(counts[label] ?? {})
    if (!values.length || values.every((n) => n === 1)) {
      throw new Error(
        `traits.json lists "${label}" as a rarity trait, but every token's value is unique, ` +
          `so a count over it carries no information. Move it to identityTraits.`,
      )
    }
  }

  const files = [
    ['collection.json', buildCollection(source, counts)],
    ...tokens.map((token) => [
      join('metadata', `${pad(token.id)}.json`),
      buildToken(token, counts, tokens.length, rarityTraits),
    ]),
  ]

  mkdirSync(metadataDir, { recursive: true })

  let stale = 0
  for (const [relative, document] of files) {
    const path = join(collectionDir, relative)
    const next = `${JSON.stringify(document, null, 2)}\n`
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null

    if (current === next) continue
    stale += 1
    if (check) {
      console.error(`stale: brand/veil-masquerade/${relative.replace(/\\/g, '/')}`)
      continue
    }
    writeFileSync(path, next, 'utf8')
  }

  if (check) {
    if (stale) {
      console.error(
        `\n${stale} file(s) do not match traits.json. Run: node scripts/build-nft-metadata.mjs`,
      )
      process.exit(1)
    }
    console.log(`Metadata matches traits.json (${tokens.length} tokens).`)
    return
  }

  console.log(`Wrote ${files.length} file(s) for ${tokens.length} tokens.`)
  for (const [label] of TRAIT_FIELDS.filter(([label]) => rarityTraits.includes(label))) {
    const line = Object.entries(counts[label])
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => `${value} ${n}`)
      .join(' · ')
    console.log(`  ${label.padEnd(9)} ${line}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('build-nft-metadata.mjs')) main()
