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
 *   node scripts/build-nft-metadata.mjs --bind <id> <name>  # permanently bind name #N to Masquerade #N
 *   node scripts/build-nft-metadata.mjs --get-figure <order> # view figure for claim order
 *
 * The `image` field is a placeholder until the art is final — see
 * `brand/veil-masquerade/README.md`. Nothing is minted from this yet.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const collectionDir = join(repoRoot, 'brand', 'veil-masquerade')
export const metadataDir = join(collectionDir, 'metadata')
export const artDir = join(collectionDir, 'art')

/**
 * Where the wallet serves the collection from.
 *
 * The art and the metadata are published together, to one directory, because
 * `token_uri` resolves to `<base>/NN.json` and that file's `image` resolves to
 * `<base>/NN.jpg`. Split them across two hosts and one can go dark while the
 * other answers, which looks like a broken token rather than a broken deploy.
 */
export const publishDir = join(repoRoot, 'frontend', 'wallet', 'public', 'masquerade')

/**
 * Where the images live.
 *
 * Read from `brand/veil-masquerade/image-base.txt`, which holds the CID of the
 * pinned `art/` directory. Until that file exists the base is an obvious
 * placeholder rather than a guessed URL: metadata pointing at a
 * plausible-looking address nobody has uploaded to is worse than metadata that
 * admits it is unfinished, because the first kind mints.
 */
const IMAGE_BASE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand', 'veil-masquerade', 'image-base.txt')
export const IMAGE_BASE = existsSync(IMAGE_BASE_FILE)
  ? readFileSync(IMAGE_BASE_FILE, 'utf8').trim()
  : 'ipfs://REPLACE_WITH_COLLECTION_CID'

export const TRAIT_FIELDS = [
  ['Crown', 'crown'],
  ['Aperture', 'aperture'],
  ['Ornament', 'ornament'],
  ['Palette', 'palette'],
  ['Hem', 'hem'],
]

export function pad(id) {
  return String(id).padStart(2, '0')
}

/**
 * The art file for a token, named by the trait table rather than guessed.
 *
 * The extension used to be hardcoded `.png` while the art is `.jpg`, which
 * would have minted twenty tokens pointing at files that do not exist.
 */
export function imageFile(token) {
  if (!token.image) {
    throw new Error(`Token #${pad(token.id)} has no \`image\` in traits.json`)
  }
  return token.image
}

export class FigureAlreadyBoundError extends Error {
  constructor(figureId, boundName) {
    super(`Figure #${pad(figureId)} is permanently bound to "${boundName}" and cannot be reassigned.`)
    this.name = 'FigureAlreadyBoundError'
    this.figureId = figureId
    this.boundName = boundName
  }
}

export class FigureIndexOutOfBoundsError extends Error {
  constructor(claimOrder) {
    super(`Claimant #${claimOrder} is beyond the 20 figures in Veil Masquerade. No figure available.`)
    this.name = 'FigureIndexOutOfBoundsError'
    this.claimOrder = claimOrder
  }
}

/** How many tokens share each value of each trait. */
export function countTraits(tokens) {
  const counts = {}
  for (const [label, field] of TRAIT_FIELDS) {
    counts[label] = {}
    for (const token of tokens) {
      const value = token[field]
      if (value !== undefined && value !== null) {
        counts[label][value] = (counts[label][value] ?? 0) + 1
      }
    }
  }

  // Count Name trait dynamically if present
  const nameCounts = {}
  for (const token of tokens) {
    if (token.name) {
      nameCounts[token.name] = (nameCounts[token.name] ?? 0) + 1
    }
  }
  if (Object.keys(nameCounts).length > 0) {
    counts['Name'] = nameCounts
  }

  return counts
}

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

/**
 * The metadata document for one token.
 *
 * `trait_type` / `value` is the convention the wallet reads. The rarity of each
 * trait goes in as a plain sentence in the description rather than a numeric
 * "score": a score implies a market ranking nobody has agreed, while "1 of 20"
 * is just true.
 *
 * If a name has been claimed for this token, the `Name` trait is appended to attributes.
 */
export function buildToken(token, counts, total, rarityTraits) {
  const attributes = TRAIT_FIELDS.map(([label, field]) => ({
    trait_type: label,
    value: token[field],
  }))

  if (token.name) {
    attributes.push({
      trait_type: 'Name',
      value: token.name,
    })
  }

  // Rarity is only read off the SHARED traits. Every Crown in the set is
  // unique, so "1 of 20" on a crown reads as significant and means nothing —
  // it is what makes the figure itself, not what makes it rare.
  const rarest = TRAIT_FIELDS.filter(([label]) => rarityTraits.includes(label))
    .map(([label, field]) => ({ label, value: token[field], count: counts[label][token[field]] }))
    .sort((a, b) => a.count - b.count || a.label.localeCompare(b.label))[0]

  const traitSentence = TRAIT_FIELDS.map(([label, field]) => `${label}: ${token[field]}.`).join(' ')
  const boundSentence = token.name ? ` Permanently bound to name: ${token.name}.` : ''

  return {
    name: `Veil Masquerade #${pad(token.id)}`,
    description:
      `A cloth figure for Veil: a crowned mask over layered, patterned cloth falling to an uneven hem. ` +
      `${traitSentence} ` +
      `${rarityLine(rarest, total)} ` +
      `No face — where the cloth is open, it is cloth removed rather than features drawn on.${boundSentence}`,
    image: `${IMAGE_BASE}/${imageFile(token)}`,
    external_url: 'https://useveilapp.xyz',
    attributes,
  }
}

export function buildCollection(source, counts) {
  const { collection } = source
  return {
    name: collection.name,
    symbol: collection.symbol,
    description: collection.description,
    external_url: collection.externalUrl,
    image: `${IMAGE_BASE}/01.jpg`,
    total_supply: source.tokens.length,
    /** Counted from the trait table, never asserted. */
    trait_counts: counts,
  }
}

/**
 * Returns figure details for a claimant based on claim order (1-indexed).
 * If claimant is > 20, returns null for figure and a message stating no figure is available.
 */
export function getFigureForClaim(claimOrder, customSource) {
  const id = Number(claimOrder)
  if (isNaN(id) || id < 1) {
    throw new Error(`Invalid claim order: ${claimOrder}`)
  }

  if (id > 20) {
    return {
      claimOrder: id,
      hasFigure: false,
      figure: null,
      message: 'All 20 Veil Masquerade figures have been allocated. You will receive your name, but no Masquerade figure token.',
    }
  }

  const source = customSource ?? JSON.parse(readFileSync(join(collectionDir, 'traits.json'), 'utf8'))
  const token = source.tokens.find((t) => t.id === id)
  if (!token) {
    throw new Error(`Token #${id} not found in collection`)
  }

  return {
    claimOrder: id,
    hasFigure: true,
    figure: {
      id: token.id,
      name: `Veil Masquerade #${pad(token.id)}`,
      image: `${IMAGE_BASE}/${imageFile(token)}`,
      crown: token.crown,
      aperture: token.aperture,
      ornament: token.ornament,
      palette: token.palette,
      hem: token.hem,
      isClosedMask: token.aperture === 'None',
      boundName: token.name ?? null,
      isAvailable: !token.name,
    },
    message: token.id === 9
      ? 'Veil Masquerade #09 — the only closed mask in the set (aperture: None) — goes to the ninth claimant in sequence.'
      : undefined,
  }
}

/**
 * Permanently binds name #N to Masquerade figure #N (1..20).
 * Prevents re-assignment if already bound.
 */
export function bindClaimToFigure(claimOrder, name, options = {}) {
  const { traitsPath = join(collectionDir, 'traits.json'), writeFiles = true } = options
  const id = Number(claimOrder)
  if (isNaN(id) || id < 1) {
    throw new Error(`Invalid claim order: ${claimOrder}`)
  }

  if (id > 20) {
    return {
      success: false,
      hasFigure: false,
      figureId: null,
      message: 'Claimant 21+ receives no figure. Name claimed without Masquerade token.',
    }
  }

  const source = JSON.parse(readFileSync(traitsPath, 'utf8'))
  const token = source.tokens.find((t) => t.id === id)
  if (!token) {
    throw new Error(`Token #${id} not found in collection`)
  }

  if (token.name) {
    throw new FigureAlreadyBoundError(id, token.name)
  }

  token.name = name.trim()

  if (writeFiles) {
    writeFileSync(traitsPath, `${JSON.stringify(source, null, 2)}\n`, 'utf8')
    buildMetadataFiles(source, { check: false, targetDir: dirname(traitsPath) })
  }

  return {
    success: true,
    hasFigure: true,
    figureId: id,
    figureName: `Veil Masquerade #${pad(id)}`,
    boundName: token.name,
    token,
  }
}

export function buildMetadataFiles(source, options = {}) {
  const { check = false, targetDir = collectionDir, flat = false } = options
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

  // Served flat, so `<base>/NN.json` and `<base>/NN.jpg` sit together; kept
  // under metadata/ in the repo, where the art has its own directory.
  const files = [
    ['collection.json', buildCollection(source, counts)],
    ...tokens.map((token) => [
      flat ? `${pad(token.id)}.json` : join('metadata', `${pad(token.id)}.json`),
      buildToken(token, counts, tokens.length, rarityTraits),
    ]),
  ]

  mkdirSync(flat ? targetDir : join(targetDir, 'metadata'), { recursive: true })

  let stale = 0
  for (const [relative, document] of files) {
    const path = join(targetDir, relative)
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
    return { stale: 0, checked: files.length }
  }

  console.log(`Wrote ${files.length} file(s) for ${tokens.length} tokens.`)
  for (const [label] of TRAIT_FIELDS.filter(([label]) => rarityTraits.includes(label))) {
    const line = Object.entries(counts[label])
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => `${value} ${n}`)
      .join(' · ')
    console.log(`  ${label.padEnd(9)} ${line}`)
  }

  return { written: files.length }
}

/**
 * Copy the art into the wallet's public directory.
 *
 * The originals stay in `brand/veil-masquerade/art/` and are not served: those
 * are the mint-quality source, and losing them would be unrecoverable. The
 * published copies are re-encoded for the web by `scripts/publish-nft-art.py`.
 * This only checks that every token has one, because metadata pointing at a
 * missing image is the failure that cannot be fixed after a mint.
 */
export function checkPublishedArt(source, { fix = false } = {}) {
  const missing = []
  for (const token of source.tokens) {
    const name = imageFile(token)
    const published = join(publishDir, name)
    if (existsSync(published)) continue
    const original = join(artDir, name)
    if (fix && existsSync(original)) {
      mkdirSync(publishDir, { recursive: true })
      copyFileSync(original, published)
      continue
    }
    missing.push(name)
  }
  if (missing.length) {
    throw new Error(
      `${missing.length} image(s) are not published to frontend/wallet/public/masquerade: ` +
        `${missing.join(', ')}. Run: python scripts/publish-nft-art.py`,
    )
  }
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const bindIdx = args.indexOf('--bind')
  const getFigIdx = args.indexOf('--get-figure')

  if (getFigIdx !== -1) {
    const order = parseInt(args[getFigIdx + 1], 10)
    const res = getFigureForClaim(order)
    console.log(JSON.stringify(res, null, 2))
    return
  }

  if (bindIdx !== -1) {
    const id = parseInt(args[bindIdx + 1], 10)
    const name = args[bindIdx + 2]
    if (!id || !name) {
      console.error('Usage: node scripts/build-nft-metadata.mjs --bind <figureId> <name>')
      process.exit(1)
    }
    try {
      const result = bindClaimToFigure(id, name)
      console.log(`Successfully bound Figure #${pad(id)} to name: ${name}`)
      console.log(JSON.stringify(result, null, 2))
    } catch (err) {
      console.error(`Binding failed: ${err.message}`)
      process.exit(1)
    }
    return
  }

  const source = JSON.parse(readFileSync(join(collectionDir, 'traits.json'), 'utf8'))
  buildMetadataFiles(source, { check })
  // The served copy is generated too, so the thing a buyer's wallet fetches
  // cannot drift from the thing in the repo.
  buildMetadataFiles(source, { check, targetDir: publishDir, flat: true })
  checkPublishedArt(source)
}

if (process.argv[1] && process.argv[1].endsWith('build-nft-metadata.mjs')) main()
