import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  countTraits,
  buildToken,
  buildCollection,
  getFigureForClaim,
  bindClaimToFigure,
  buildMetadataFiles,
  FigureAlreadyBoundError,
  pad,
  IMAGE_BASE,
  imageFile,
} from '../build-nft-metadata.mjs'

describe('build-nft-metadata', () => {
  const sampleTokens = [
    { id: 1, crown: 'Plume', aperture: 'Twin slits', ornament: 'Chevrons', palette: 'Lilac', hem: 'Beaded fringe', image: '01.jpg' },
    { id: 2, crown: 'Drum cap', aperture: 'Slot', ornament: 'Diamonds', palette: 'Gold + teal', hem: 'Scalloped', image: '02.jpg' },
    { id: 3, crown: 'Beaded dome', aperture: 'Slot', ornament: 'Zigzag', palette: 'Lilac', hem: 'Scalloped', image: '03.jpg' },
  ]

  test('a token with no image is refused rather than given a guessed extension', () => {
    // The extension used to be hardcoded `.png` while the art is `.jpg`, which
    // would have minted twenty tokens pointing at files that are not there.
    // Nothing downstream can fix that, so it fails here instead.
    assert.throws(
      () => imageFile({ id: 7 }),
      /#07 has no `image`/,
    )
    assert.equal(imageFile({ id: 7, image: '07.jpg' }), '07.jpg')
  })

  test('countTraits tallies frequencies dynamically from token attributes', () => {
    const counts = countTraits(sampleTokens)
    assert.equal(counts['Crown']['Plume'], 1)
    assert.equal(counts['Crown']['Drum cap'], 1)
    assert.equal(counts['Aperture']['Slot'], 2)
    assert.equal(counts['Aperture']['Twin slits'], 1)
    assert.equal(counts['Palette']['Lilac'], 2)
    assert.equal(counts['Palette']['Gold + teal'], 1)
    assert.equal(counts['Hem']['Scalloped'], 2)
    // No Name present yet
    assert.equal(counts['Name'], undefined)

    // With Name present on one token
    const tokensWithName = [
      ...sampleTokens,
      { id: 4, crown: 'Crescent', aperture: 'Slot', ornament: 'Dots', palette: 'Gold', hem: 'Pointed', name: 'alice*useveilapp.xyz' },
    ]
    const countsWithName = countTraits(tokensWithName)
    assert.equal(countsWithName['Name']['alice*useveilapp.xyz'], 1)
  })

  test('buildToken produces valid CAP-46 attributes and appends Name trait when bound', () => {
    const counts = countTraits(sampleTokens)
    const rarityTraits = ['Aperture', 'Palette', 'Hem']

    // Token without name
    const doc1 = buildToken(sampleTokens[0], counts, 3, rarityTraits)
    assert.equal(doc1.name, 'Veil-ian #01')
    assert.equal(doc1.image, `${IMAGE_BASE}/01.jpg`)
    assert.equal(doc1.attributes.some((a) => a.trait_type === 'Name'), false)
    assert.equal(doc1.attributes.find((a) => a.trait_type === 'Crown')?.value, 'Plume')

    // Token with name bound
    const tokenWithName = { ...sampleTokens[0], name: 'saturn*useveilapp.xyz' }
    const docBound = buildToken(tokenWithName, counts, 3, rarityTraits)
    const nameAttr = docBound.attributes.find((a) => a.trait_type === 'Name')
    assert.ok(nameAttr, 'Name trait must be present in attributes')
    assert.equal(nameAttr.value, 'saturn*useveilapp.xyz')
    assert.match(docBound.description, /Permanently bound to name: saturn\*useveilapp\.xyz/)
  })

  test('buildCollection records dynamic trait counts without hardcoded assertions', () => {
    const source = {
      collection: {
        name: 'Veil Masquerade',
        symbol: 'VMASQ',
        description: 'Test collection',
        externalUrl: 'https://useveilapp.xyz',
      },
      tokens: sampleTokens,
    }
    const counts = countTraits(sampleTokens)
    const col = buildCollection(source, counts)
    assert.equal(col.name, 'Veil Masquerade')
    assert.equal(col.total_supply, 3)
    assert.deepEqual(col.trait_counts, counts)
  })

  test('getFigureForClaim maps claim orders 1..20 to figure details, allocates #09 to 9th claimant, and alerts claimant 21+', () => {
    // Claimant #1
    const claim1 = getFigureForClaim(1)
    assert.equal(claim1.hasFigure, true)
    assert.equal(claim1.figure.id, 1)
    assert.equal(claim1.figure.name, 'Veil-ian #01')

    // Claimant #9 gets the unique closed mask (#09)
    const claim9 = getFigureForClaim(9)
    assert.equal(claim9.hasFigure, true)
    assert.equal(claim9.figure.id, 9)
    assert.equal(claim9.figure.name, 'Veil-ian #09')
    assert.equal(claim9.figure.aperture, 'None')
    assert.equal(claim9.figure.isClosedMask, true)
    assert.match(claim9.message, /goes to the ninth claimant in sequence/)

    // Claimant #20
    const claim20 = getFigureForClaim(20)
    assert.equal(claim20.hasFigure, true)
    assert.equal(claim20.figure.id, 20)
    assert.equal(claim20.figure.name, 'Veil-ian #20')

    // Claimant #21 gets told there is no figure before paying
    const claim21 = getFigureForClaim(21)
    assert.equal(claim21.hasFigure, false)
    assert.equal(claim21.figure, null)
    assert.match(claim21.message, /All 20 Veil-ians have been allocated/)
    assert.match(claim21.message, /no Veil-ian/)
  })

  test('bindClaimToFigure permanently binds figure, prevents re-assignment, and updates metadata with Name trait passing --check', () => {
    // Create an isolated temporary test directory
    const tempDir = mkdtempSync(join(tmpdir(), 'veil-masquerade-test-'))
    try {
      const mockTraits = {
        collection: {
          name: 'Veil-ians Test',
          symbol: 'VMASQ',
          size: 2,
          description: 'Test',
          externalUrl: 'https://useveilapp.xyz',
        },
        traitTypes: ['Crown', 'Aperture', 'Ornament', 'Palette', 'Hem', 'Name'],
        identityTraits: ['Crown', 'Ornament', 'Name'],
        rarityTraits: ['Aperture'],
        tokens: [
          { id: 1, crown: 'Plume', aperture: 'Twin slits', ornament: 'Chevrons', palette: 'Lilac', hem: 'Beaded fringe', image: '01.jpg' },
          { id: 2, crown: 'Drum cap', aperture: 'Twin slits', ornament: 'Diamonds', palette: 'Gold + teal', hem: 'Scalloped', image: '02.jpg' },
        ],
      }

      const traitsPath = join(tempDir, 'traits.json')
      writeFileSync(traitsPath, JSON.stringify(mockTraits, null, 2), 'utf8')

      // 1. Initial build in temp dir
      buildMetadataFiles(mockTraits, { check: false, targetDir: tempDir })
      const checkRes = buildMetadataFiles(mockTraits, { check: true, targetDir: tempDir })
      assert.equal(checkRes.stale, 0)

      // 2. Bind claimant 1 to "genesis*useveilapp.xyz"
      const bindResult = bindClaimToFigure(1, 'genesis*useveilapp.xyz', { traitsPath, writeFiles: true })
      assert.equal(bindResult.success, true)
      assert.equal(bindResult.figureId, 1)
      assert.equal(bindResult.boundName, 'genesis*useveilapp.xyz')

      // 3. Verify metadata/01.json contains the Name trait
      const meta01 = JSON.parse(readFileSync(join(tempDir, 'metadata', '01.json'), 'utf8'))
      const nameAttr = meta01.attributes.find((a) => a.trait_type === 'Name')
      assert.ok(nameAttr, 'metadata/01.json must contain Name attribute')
      assert.equal(nameAttr.value, 'genesis*useveilapp.xyz')

      // 4. Verify --check passes with Name trait present
      const updatedTraits = JSON.parse(readFileSync(traitsPath, 'utf8'))
      const checkAfterBind = buildMetadataFiles(updatedTraits, { check: true, targetDir: tempDir })
      assert.equal(checkAfterBind.stale, 0)

      // 5. Re-assignment attempt MUST fail: claim order cannot be reassigned afterwards
      assert.throws(
        () => {
          bindClaimToFigure(1, 'intruder*useveilapp.xyz', { traitsPath, writeFiles: true })
        },
        FigureAlreadyBoundError,
        'Attempting to reassign figure #01 must throw FigureAlreadyBoundError'
      )

      // 6. Claimant 21+ gets no figure
      const overClaim = bindClaimToFigure(21, 'latecomer*useveilapp.xyz', { traitsPath, writeFiles: true })
      assert.equal(overClaim.hasFigure, false)
      assert.equal(overClaim.figureId, null)
      assert.match(overClaim.message, /Claimant 21\+ receives no figure/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
