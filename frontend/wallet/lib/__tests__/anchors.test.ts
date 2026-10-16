import { getDefaultAnchor } from '../anchors'

describe('getDefaultAnchor', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_SEP24_ANCHORS

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_SEP24_ANCHORS
    else process.env.NEXT_PUBLIC_SEP24_ANCHORS = ORIGINAL
  })

  it("defaults to '' — never a hard-coded testnet anchor — when the env is unset", () => {
    delete process.env.NEXT_PUBLIC_SEP24_ANCHORS

    // Before the fix this returned 'testanchor.stellar.org', pointing mainnet
    // users at a testnet anchor by default.
    expect(getDefaultAnchor()).toBe('')
  })

  it('takes the first entry when the env lists several anchors', () => {
    process.env.NEXT_PUBLIC_SEP24_ANCHORS = ' anchor-a.example , anchor-b.example '

    expect(getDefaultAnchor()).toBe('anchor-a.example')
  })

  it("falls back to '' when the env is set but empty", () => {
    process.env.NEXT_PUBLIC_SEP24_ANCHORS = '  '

    expect(getDefaultAnchor()).toBe('')
  })
})
