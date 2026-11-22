process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

type DegitCall = { src: string; dest: string; opts: Record<string, unknown> };
const degitCalls: DegitCall[] = [];
let cloneError: Error | null = null;

const degitHandler = (src: string, opts: Record<string, unknown>) => ({
  clone: async (dest: string) => {
    degitCalls.push({ src, dest, opts });
    if (cloneError) {
      throw cloneError;
    }
  },
});

mock.module('degit', {
  defaultExport: degitHandler,
  namedExports: {
    default: degitHandler,
  },
});

const { scaffold } = await import('./index.js');

describe('create-veil-app', () => {
  let warnCalls: string[] = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    degitCalls.length = 0;
    cloneError = null;
    warnCalls = [];
    delete process.env.VEIL_TEMPLATE_REF;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    delete process.env.VEIL_TEMPLATE_REF;
    console.warn = originalWarn;
  });

  test('default path uses a tag ref derived from package version', async () => {
    delete process.env.VEIL_TEMPLATE_REF;
    const targetDir = path.join(os.tmpdir(), 'test-veil-default');

    await scaffold('next', targetDir, { skipInstall: true });

    assert.equal(degitCalls.length, 2);
    const expectedRef = `v${version}`;
    assert.equal(degitCalls[0].src, `Miracle656/veil/examples/nextjs#${expectedRef}`);
    assert.equal(degitCalls[1].src, `Miracle656/veil/sdk#${expectedRef}`);
    assert(!degitCalls[0].src.endsWith('#main'));
    assert(!degitCalls[1].src.endsWith('#main'));
  });

  test('VEIL_TEMPLATE_REF override is used when set', async () => {
    process.env.VEIL_TEMPLATE_REF = 'my-custom-ref';
    const targetDir = path.join(os.tmpdir(), 'test-veil-override');

    await scaffold('next', targetDir, { skipInstall: true });

    assert.equal(degitCalls.length, 2);
    assert.equal(degitCalls[0].src, 'Miracle656/veil/examples/nextjs#my-custom-ref');
    assert.equal(degitCalls[1].src, 'Miracle656/veil/sdk#my-custom-ref');
    assert.equal(warnCalls.length, 1);
    assert(warnCalls[0].includes('my-custom-ref'));
  });

  test('missing tag produces a readable error', async () => {
    delete process.env.VEIL_TEMPLATE_REF;
    const targetDir = path.join(os.tmpdir(), 'test-veil-missing');
    cloneError = new Error('could not find commit hash for tag v0.1.0\n    at degit.clone (degit/internal.js:42)');

    await assert.rejects(
      async () => {
        await scaffold('next', targetDir, { skipInstall: true });
      },
      (err: Error) => {
        assert(err.message.includes('does not exist'));
        assert(err.message.includes(`v${version}`));
        assert(!err.message.includes('could not find commit hash'));
        assert(!err.message.includes('degit/internal.js'));
        return true;
      }
    );
  });

  test('no override prints nothing', async () => {
    delete process.env.VEIL_TEMPLATE_REF;
    const targetDir = path.join(os.tmpdir(), 'test-veil-no-warn');

    await scaffold('next', targetDir, { skipInstall: true });

    assert.equal(warnCalls.length, 0);
  });
});
