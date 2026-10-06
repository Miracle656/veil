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

## Rights: what you can and cannot do with the current images

**You can sell AI-generated art.** It is not prohibited, and Canva Pro grants
commercial rights to what it generates. These twenty came through Veil's own
Canva account, so that account's plan terms govern them — check those before
anything is listed, since they beat any summary written here.

**The constraint is exclusivity, not legality, and it only bites for a
collection.** Two things combine:

- Copyright offices generally do not grant copyright to work without meaningful
  human authorship, so there may be nothing to stop a third party using the same
  image.
- Canva grants commercial *use* without granting *exclusive* rights.

For a landing page or a social post, neither matters. For a collectible whose
value rests on "there are only twenty of these", it is the gap between what a
buyer assumes and what can actually be delivered.

So the practical split:

| Use | These images |
| --- | --- |
| Brand art, marketing, onboarding, concept work | fine as they are |
| A collection sold on the promise of scarcity | commission the final art |

Commissioned work-for-hire, with copyright assigned in the contract, is the
usual way to end up owning the set outright. The twenty concepts are a good
brief for that, and nothing in this directory has to change when the art does:
`traits.json` stays, and only the `image` URLs move.

Minting these as they stand is a legitimate choice too. The downside is narrow
and specific — you cannot promise exclusivity — and plenty of collections do not
trade on that at all. It should be a decision rather than an oversight, which is
the only reason it is written down here.

*None of the above is legal advice, and it differs between Nigeria and the US.*

## Drawing on Egungun and Mmanwu

`docs/BRAND_MASCOT.md` asks for a read from someone Nigerian whose judgement is
trusted before the figure reaches anything public, and twenty masked ceremonial
figures sold as collectibles is further past that line than an abstract gold
silhouette was.

That is a recommendation, not a rule, and the call belongs to whoever is
shipping it. Commissioning the final art from a Nigerian illustrator is one way
to answer both this and the rights question at once; it is not the only way, and
it is not a precondition anyone else gets to impose.

## What is missing before this can be minted

1. **Final art**, if the collection is sold on scarcity — see *Rights* above.
   The images are AI-generated concepts at preview resolution either way.
2. **Hosting.** `image` is `ipfs://REPLACE_WITH_COLLECTION_CID/NN.png` — a
   deliberate placeholder, not a guessed URL. Metadata that points at a
   plausible-looking address nobody has uploaded to is worse than metadata that
   admits it is unfinished, because the first kind mints.
3. **A contract.** Veil's wallet reads CAP-46 tokens. Nothing in this directory
   assumes a particular contract; the metadata is what any of them would point
   at.
