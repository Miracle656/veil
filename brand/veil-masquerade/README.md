# Veil Masquerade — a 20-piece collection

Twenty cloth figures drawn from the mascot direction in
[`docs/BRAND_MASCOT.md`](../../docs/BRAND_MASCOT.md). Same form throughout — a
crowned mask over layered, patterned cloth falling to an uneven hem — varied
across five traits.

**Nothing here is minted, and the art is not final.** This is the metadata and
the trait system; the images are still concept art. See *What is missing* below.

## What metadata is, if you have not done this before

An NFT on-chain is mostly a number: a token id, and who owns it. Everything a
person actually sees — the picture, the name, the list of traits — lives in a
JSON document somewhere else, and the token points at it with a `tokenUri`.

So there are three separate things, and they are usually confused:

| | What it is | Where it lives |
| --- | --- | --- |
| The token | id + owner | the contract, on Stellar |
| The metadata | this JSON | wherever you host it |
| The image | a PNG | wherever you host it, named by the metadata |

A wallet showing an NFT reads the token's `tokenUri`, fetches that JSON, and
renders `name`, `image` and `attributes` from it. Veil already does exactly
this — `frontend/wallet/lib/nfts.ts`, which parses the `trait_type` / `value`
shape these files use. That shape is the de-facto standard, so marketplaces and
indexers read it too; none of it is Veil-specific.

## The files

```
traits.json              the source of truth — edit THIS
collection.json          generated: collection-level metadata, with counted rarity
metadata/01.json … 20.json   generated: one document per token
```

`collection.json` and `metadata/` are **generated**. Do not edit them by hand:

```bash
node scripts/build-nft-metadata.mjs          # rebuild from traits.json
node scripts/build-nft-metadata.mjs --check  # fail if they are stale
```

Twenty hand-edited files drift, and rarity has to be *counted* rather than
claimed — "1 of 20" written by hand is an assertion, counted from the trait
table it is a fact that moves when a trait is edited.

## The trait system

**Identity traits** — Crown and Ornament. Near enough one value per token;
they are what makes each figure itself.

**Rarity traits** — Aperture, Palette and Hem. Shared across tokens, so a count
over them means something:

| Aperture | | Palette | | Hem | |
| --- | --- | --- | --- | --- | --- |
| Slot | 7 | Gold | 5 | Scalloped | 4 |
| Twin slits | 6 | Lilac | 4 | Beaded fringe | 3 |
| Woven band | 6 | Bone · Teal · Bone+lilac · Bone+teal · Gold+teal | 2 each | Pointed · Ragged | 3 each |
| **None** | **1** | Gold + lilac | 1 | Layered · Long fringe · Straight | 2 each |
| | | | | Pointed fringe | 1 |

**#09 is the only closed mask in the set** — no aperture at all. That is the
piece most faithful to the direction's own argument that no face is the point,
and it fell out of the trait grid rather than being contrived.

The build refuses to treat a trait as rarity-bearing if every token's value is
unique, because a "1 of 20" drawn from a trait that is unique by construction
reads as significant and says nothing.

## What is missing before this can be minted

1. **Final art.** The images are AI-generated concepts at preview resolution.
   For a collection that is distributed or sold, commission the real artwork —
   and given it draws on Egungun and Mmanwu, commission it from a Nigerian
   illustrator. That is the right cultural call and it gives clean ownership,
   which matters for a store listing and for anything resold.
2. **A cultural read.** `docs/BRAND_MASCOT.md` asks for one before the figure
   reaches anything public. Twenty masked ceremonial figures as collectibles is
   well past that line, and the read belongs *before* minting, not before
   marketing.
3. **Hosting.** `image` is `ipfs://REPLACE_WITH_COLLECTION_CID/NN.png` — a
   deliberate placeholder, not a guessed URL. Metadata that points at a
   plausible-looking address nobody has uploaded to is worse than metadata that
   admits it is unfinished, because the first kind mints.
4. **A contract.** Veil's wallet reads CAP-46 tokens. Nothing in this directory
   assumes a particular contract; the metadata is what any of them would point
   at.
