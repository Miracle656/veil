#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import degit from 'degit';
import prompts from 'prompts';
const REPO = process.env.VEIL_TEMPLATE_REPO ?? 'Miracle656/veil';
const TEMPLATES = {
    next: { label: 'Next.js', dir: 'examples/nextjs' },
    vite: { label: 'Vite + React', dir: 'examples/vite-react' },
    vanilla: { label: 'Vanilla JS', dir: 'examples/vanilla' },
};
function isTemplateKey(value) {
    return value in TEMPLATES;
}
function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`));
        });
    });
}
function replaceInFile(filePath, search, replace) {
    if (!fs.existsSync(filePath))
        return;
    const contents = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, contents.split(search).join(replace));
}
// The vendored sdk/ is consumed as a built dependency, not project source.
// Without this, a template's own tsconfig.json (e.g. Next.js's "**/*.ts"
// include) sweeps up the SDK's raw TypeScript and type-checks it against
// the app's compiler target, which can fail (e.g. ES2017 vs. the SDK's
// ES2020 BigInt literals).
function excludeSdkFromTsconfig(targetDir) {
    const tsconfigPath = path.join(targetDir, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath))
        return;
    try {
        const config = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
        const exclude = Array.isArray(config.exclude) ? config.exclude : [];
        if (!exclude.includes('sdk'))
            exclude.push('sdk');
        config.exclude = exclude;
        fs.writeFileSync(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    catch {
        console.warn('Could not update tsconfig.json to exclude sdk/ — you may need to add it manually.');
    }
}
function parseArgs(argv) {
    const positionals = [];
    let template;
    for (const arg of argv) {
        if (arg.startsWith('--template='))
            template = arg.slice('--template='.length);
        else if (!arg.startsWith('-'))
            positionals.push(arg);
    }
    return { name: positionals[0], template };
}
async function main() {
    const { name: nameArg, template: templateArg } = parseArgs(process.argv.slice(2));
    let name = nameArg;
    if (!name) {
        const response = await prompts({ type: 'text', name: 'name', message: 'Project name', initial: 'my-veil-app' }, { onCancel: () => process.exit(1) });
        name = response.name;
    }
    if (!name) {
        console.error('A project name is required.');
        process.exit(1);
    }
    const targetDir = path.resolve(process.cwd(), name);
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
        console.error(`Directory "${name}" already exists and is not empty.`);
        process.exit(1);
    }
    let template = templateArg;
    if (!template || !isTemplateKey(template)) {
        const response = await prompts({
            type: 'select',
            name: 'template',
            message: 'Choose a template',
            choices: Object.entries(TEMPLATES).map(([value, { label }]) => ({ title: label, value })),
        }, { onCancel: () => process.exit(1) });
        template = response.template;
    }
    if (!template || !isTemplateKey(template)) {
        console.error(`A template choice is required. Available: ${Object.keys(TEMPLATES).join(', ')}`);
        process.exit(1);
    }
    const { dir, label } = TEMPLATES[template];
    console.log(`\nScaffolding ${label} app in ./${name}...\n`);
    await degit(`${REPO}/${dir}`, { force: true }).clone(targetDir);
    console.log('Fetching the Veil SDK...');
    await degit(`${REPO}/sdk`, { force: true }).clone(path.join(targetDir, 'sdk'));
    // Templates reference the SDK from the monorepo (file:../../sdk); once
    // scaffolded standalone the SDK lives at ./sdk instead.
    replaceInFile(path.join(targetDir, 'package.json'), 'file:../../sdk', 'file:./sdk');
    replaceInFile(path.join(targetDir, 'index.html'), '../../sdk/dist/vanilla.js', './sdk/dist/vanilla.js');
    excludeSdkFromTsconfig(targetDir);
    console.log('Installing SDK dependencies and building...');
    await run('npm', ['install'], path.join(targetDir, 'sdk'));
    await run('npm', ['run', 'build'], path.join(targetDir, 'sdk'));
    if (fs.existsSync(path.join(targetDir, 'package.json'))) {
        console.log('Installing app dependencies...');
        await run('npm', ['install'], targetDir);
    }
    console.log(`\nDone! Next steps:\n`);
    console.log(`  cd ${name}`);
    console.log(template === 'vanilla' ? '  npx http-server .   # or any static file server' : '  npm run dev');
    console.log(`\nSee ${name}/README.md for environment variables (factory address, RPC URL, etc.).\n`);
}
main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
