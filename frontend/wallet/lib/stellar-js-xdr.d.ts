/**
 * `@stellar/js-xdr` ships no type declarations of its own, and (per
 * docs/SEP45_SPIKE.md) it is a CommonJS module with `__esModule: true` but no
 * `default` export — a default import (`import jsXdr from '@stellar/js-xdr'`)
 * resolves to `undefined` under `esModuleInterop`, so `lib/sep45.ts` uses a
 * namespace import (`import * as jsXdr from '@stellar/js-xdr'`) instead. This
 * covers only the surface that file actually uses: the generic reader/writer
 * pair, and the variable-length array type built from a child XDR type — which
 * is what a SEP-45 challenge's `authorization_entries` field encodes.
 */
declare module '@stellar/js-xdr' {
  /**
   * The subset of a generated XDR type's static surface {@link VarArray} needs
   * from its child type. The reader/writer parameters are typed loosely
   * (`any`) rather than as {@link XdrReader}/{@link XdrWriter}: `@stellar/stellar-sdk`
   * ships its own (looser, inaccurate) hand-written types for these generated
   * classes' `read`/`write` statics, and requiring an exact structural match
   * here would fight that rather than this package's own runtime, which is
   * what actually has to agree (verified by the round-trip test in
   * `lib/__tests__/sep45.test.ts`).
   */
  export interface XdrType<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    read(reader: any): T
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write(value: T, writer: any): void
  }

  export class XdrReader {
    constructor(input: Buffer | Uint8Array)
  }

  export class XdrWriter {
    constructor()
    finalize(): Buffer
  }

  export class VarArray<T> {
    constructor(childType: XdrType<T>, maxLength?: number)
    read(reader: XdrReader): T[]
    write(value: T[], writer: XdrWriter): void
  }
}
