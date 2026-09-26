/**
 * Writes public/sitemap.xml from the .mdx files under pages/.
 *
 * Runs before every build (npm `prebuild`), so a new docs page is listed the
 * moment it exists — a hand-maintained list is the one people forget to update.
 * index.mdx maps to its folder's URL, as Nextra routes it.
 *
 * No <lastmod>: a fresh clone on the build server gives every file the same
 * mtime, so it would claim every page changed at every deploy — and search
 * engines learn to ignore a lastmod that is not accurate.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCS_URL = 'https://docs.useveilapp.xyz'
const root = fileURLToPath(new URL('..', import.meta.url))
const pagesDir = join(root, 'pages')

function mdxFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return mdxFiles(full)
    return name.endsWith('.mdx') ? [full] : []
  })
}

function urlFor(file) {
  const route = relative(pagesDir, file)
    .split(sep)
    .join('/')
    .replace(/\.mdx$/, '')
    .replace(/(^|\/)index$/, '')
  return route ? `${DOCS_URL}/${route}` : DOCS_URL
}

const entries = mdxFiles(pagesDir)
  .map(urlFor)
  .sort((a, b) => a.localeCompare(b))

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map((loc) => `  <url><loc>${loc}</loc></url>`),
  '</urlset>',
  '',
].join('\n')

writeFileSync(join(root, 'public', 'sitemap.xml'), xml)
console.log(`sitemap.xml: ${entries.length} pages`)
