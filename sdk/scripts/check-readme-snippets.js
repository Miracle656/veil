#!/usr/bin/env node
/**
 * Extract and type-check every TypeScript/TSX code block from sdk/README.md.
 *
 * Prevents drift between the README's quick-start examples and the actual SDK API.
 * Blocks that are intentional fragments (not meant to compile standalone) can opt
 * out with a `// @check-readme-ignore` marker comment on the first line.
 *
 * Usage:
 *   node scripts/check-readme-snippets.js
 *
 * Returns exit 0 if every snippet type-checks, exit 1 otherwise.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const README_PATH = path.join(__dirname, '..', 'README.md');
const SDK_ROOT = path.join(__dirname, '..');

/**
 * Extract all fenced code blocks that look like TypeScript.
 * Returns an array of { lang, code, lineNumber }.
 */
function extractCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let inBlock = false;
  let currentLang = null;
  let currentCode = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w+)?/);

    if (fenceMatch && !inBlock) {
      // Start of a code block
      inBlock = true;
      currentLang = fenceMatch[1] || '';
      currentCode = [];
      startLine = i + 1;
    } else if (line.startsWith('```') && inBlock) {
      // End of a code block
      inBlock = false;
      if (['ts', 'tsx', 'typescript'].includes(currentLang.toLowerCase())) {
        blocks.push({
          lang: currentLang,
          code: currentCode.join('\n'),
          lineNumber: startLine,
        });
      }
      currentLang = null;
      currentCode = [];
    } else if (inBlock) {
      currentCode.push(line);
    }
  }

  return blocks;
}

/**
 * Check if a code block should be ignored (has the opt-out marker).
 */
function shouldIgnore(code) {
  const firstLine = code.split('\n')[0].trim();
  return firstLine.includes('@check-readme-ignore');
}

/**
 * Type-check a code snippet by writing it to a temp file and running tsc.
 */
function typeCheckSnippet(code, index, lineNumber) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-check-'));
  const tempFile = path.join(tempDir, `snippet-${index}.tsx`);
  const tempTsConfig = path.join(tempDir, 'tsconfig.json');

  try {
    // Write the snippet to a temp file
    fs.writeFileSync(tempFile, code, 'utf8');

    // Create a temporary tsconfig.json with the SDK's source paths
    const tsconfig = {
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        jsx: 'react',
        esModuleInterop: true,
        moduleResolution: 'node',
        target: 'ES2020',
        module: 'commonjs',
        lib: ['ES2020', 'DOM'],
        baseUrl: SDK_ROOT,
        paths: {
          'invisible-wallet-sdk': [path.join(SDK_ROOT, 'src', 'index.ts')],
          'invisible-wallet-sdk/*': [path.join(SDK_ROOT, 'src', '*', 'index.ts')],
        },
        ignoreDeprecations: '6.0',
      },
      include: [tempFile],
    };

    fs.writeFileSync(tempTsConfig, JSON.stringify(tsconfig, null, 2), 'utf8');

    // Run tsc --noEmit with the temp tsconfig
    const result = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsc', '--project', tempTsConfig],
      {
        cwd: SDK_ROOT,
        encoding: 'utf8',
        shell: true,
      }
    );

    if (result.status !== 0) {
      return {
        success: false,
        output: result.stdout + result.stderr,
      };
    }

    return { success: true };
  } finally {
    // Clean up temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  console.log('📖 Checking README code snippets...\n');

  const readme = fs.readFileSync(README_PATH, 'utf8');
  const blocks = extractCodeBlocks(readme);

  console.log(`Found ${blocks.length} TypeScript code block(s)\n`);

  let failures = 0;
  let ignored = 0;

  blocks.forEach((block, index) => {
    if (shouldIgnore(block.code)) {
      console.log(`⏭️  Snippet #${index + 1} (line ${block.lineNumber}): ignored (has @check-readme-ignore)`);
      ignored++;
      return;
    }

    console.log(`🔍 Checking snippet #${index + 1} (line ${block.lineNumber})...`);

    const result = typeCheckSnippet(block.code, index, block.lineNumber);

    if (result.success) {
      console.log(`✅ Snippet #${index + 1}: OK\n`);
    } else {
      console.error(`❌ Snippet #${index + 1}: FAILED`);
      console.error(`   Line ${block.lineNumber} in README.md\n`);
      console.error(result.output);
      console.error('');
      failures++;
    }
  });

  console.log('─'.repeat(60));
  console.log(`Total: ${blocks.length} snippets`);
  console.log(`✅ Passed: ${blocks.length - failures - ignored}`);
  console.log(`⏭️  Ignored: ${ignored}`);
  console.log(`❌ Failed: ${failures}`);

  if (failures > 0) {
    console.error('\n❌ Some README snippets do not type-check.');
    console.error('Fix the examples in README.md or mark them with // @check-readme-ignore');
    process.exit(1);
  }

  console.log('\n✅ All README snippets type-check successfully!');
  process.exit(0);
}

main();
