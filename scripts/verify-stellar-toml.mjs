#!/usr/bin/env node
/**
 * Guard the public SEP-1 file and the headers needed by cross-origin wallets.
 * The federation URL is planned; this check deliberately does not claim that
 * the endpoint exists or that SEP-2 resolution works yet.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const toml = require('toml');

const filePath = path.join(root, 'frontend/website/public/.well-known/stellar.toml');
const configPath = path.join(root, 'frontend/website/next.config.js');
const vercelPath = path.join(root, 'frontend/website/vercel.json');
const [source, nextConfig, vercelConfig] = await Promise.all([
  readFile(filePath, 'utf8'),
  readFile(configPath, 'utf8'),
  readFile(vercelPath, 'utf8'),
]);

const metadata = toml.parse(source);
assert.equal(
  metadata.FEDERATION_SERVER,
  'https://app.useveilapp.xyz/api/federation',
  'stellar.toml must declare the planned public federation endpoint',
);
assert.equal(metadata.DOCUMENTATION?.ORG_NAME, 'Veil', 'stellar.toml must identify the organization');
assert.equal(metadata.DOCUMENTATION?.ORG_URL, 'https://useveilapp.xyz');
assert.equal(metadata.DOCUMENTATION?.ORG_GITHUB, 'https://github.com/Miracle656/veil');
assert.match(nextConfig, /source:\s*["']\/\.well-known\/stellar\.toml["']/);
assert.match(nextConfig, /key:\s*["']Content-Type["'],\s*value:\s*["']text\/plain; charset=utf-8["']/);
assert.match(nextConfig, /key:\s*["']Access-Control-Allow-Origin["'],\s*value:\s*["']\*["']/);
assert.equal(JSON.parse(vercelConfig).framework, 'nextjs', 'Vercel must deploy the Next.js public directory');

console.log('SEP-1 stellar.toml parses and is configured for public cross-origin serving.');
console.log('Reminder: implement and deploy the declared federation endpoint before claiming SEP-2 resolution.');
