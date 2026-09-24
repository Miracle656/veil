/**
 * Minimal jest transformer that converts ESM `.mjs` sources to CommonJS.
 *
 * Angular ships its runtime exclusively as ESM (`fesm2022/*.mjs`), which jest's
 * default (CommonJS) execution cannot load — and which ts-jest refuses to
 * CommonJS-ify for `.mjs` inputs. This skips the babel stack entirely and leans
 * on the already-installed `typescript` compiler to do the module conversion,
 * so the Angular adapter tests run against the real `@angular/core`.
 */

const ts = require('typescript')

module.exports = {
  process(sourceText, sourcePath) {
    // TypeScript derives the output module format from the input extension, so
    // a `.mjs` fileName keeps emitting ESM no matter what `module` says. We
    // only use the compiler as an isolated transpiler, so a `.js` fileName is
    // safe here and the resulting `require` calls resolve fine at runtime.
    const fileName = sourcePath.replace(/\.mjs$/, '.js')

    const result = ts.transpileModule(sourceText, {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        sourceMap: false,
      },
    })

    return { code: result.outputText }
  },
}