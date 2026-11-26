# Veil-ians — a 20-piece collection

> **The collection is called Veil-ians.** It was drafted here as "Veil Masquerade",
> and that name survives in the directory and the crate (`brand/veil-masquerade`,
> `contracts/veil-masquerade`) because renaming those buys nothing. Everything a
> buyer sees — the on-chain name `Veil-ians`, the symbol `VEILIAN`, the token
> titles `Veil-ian #01` — is the real one, matching the Veil-ians Collection
> design and the `/veil-ians` page. Nothing was deployed under the old name.

Twenty cloth figures drawn from the mascot direction in
[`docs/BRAND_MASCOT.md`](../../docs/BRAND_MASCOT.md). Same form throughout — a
crowned mask over layered, patterned cloth falling to an uneven hem — varied
across five traits.

**The art is in, the metadata is served, and the contract is written and
tested — nothing is minted yet.** The twenty images live in `art/`; what the
chain points at is published from `frontend/wallet/public/masquerade/`. One
open question remains, and it is about exclusivity rather than readiness — see
*Rights* below.

## What metadata is, if you have not done this before

An NFT on-chain is mostly a number: a token id, and who owns it. Everything a
person actually sees — the picture, the name, the list of traits — lives in a
JSON document somewhere else, and the token points at it with a `tokenUri`.

So there are three separate things, and they are usually confused:

| | What it is | Where it lives |
| --- | --- | --- |
| The token | id + owner | `contracts/veil-masquerade`, on Stellar |
| The metadata | this JSON | `app.useveilapp.xyz/masquerade/NN.json` |
| The image | a JPEG | `app.useveilapp.xyz/masquerade/NN.jpg`, named by the metadata |

A wallet showing an NFT reads the token's `tokenUri`, fetches that JSON, and
renders `name`, `image` and `attributes` from it. Veil already does exactly
this — `frontend/wallet/lib/nfts.ts`, which parses the `trait_type` / `value`
shape these files use. That shape is the de-facto standard, so marketplaces and
indexers read it too; none of it is Veil-specific.

## The files

```
traits.json                  the source of truth — edit THIS
art/01.jpg … 20.jpg          the mint-quality originals; never served directly
image-base.txt               where the collection is served from
collection.json              generated: collection-level metadata, with counted rarity
metadata/01.json … 20.json   generated: one document per token
```

`collection.json`, `metadata/` and everything under
`frontend/wallet/public/masquerade/` are **generated**. Do not edit them by
hand:

```bash
python scripts/publish-nft-art.py            # re-encode art/ for the web
node scripts/build-nft-metadata.mjs          # rebuild metadata, repo + served copy
node scripts/build-nft-metadata.mjs --check  # fail if either is stale
```

The served copy is generated from the same `traits.json` as the repo copy, so
what a buyer's wallet fetches cannot drift from what is committed. `image-base.txt`
holds the prefix the metadata is written with; changing it and rebuilding is
how the collection moves to IPFS, and the contract's `set_base_uri` is how the
chain is told.

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
| Slot | 7 | Gold · Gold+teal · Lilac | 4 each | Scalloped | 4 |
| Twin slits | 6 | Bone · Bone+lilac · Gold+lilac | 2 each | Beaded fringe · Pointed · Ragged | 3 each |
| Woven band | 6 | Bone + teal | 1 | Layered · Long fringe · Straight | 2 each |
| **None** | **1** | **Teal** | **1** | Pointed fringe | 1 |

These counts are printed by `build-nft-metadata.mjs` on every rebuild; the
table above is a copy, and the build is the authority.

**#09 is the only closed mask in the set** — no aperture at all. That is the
piece most faithful to the direction's own argument that no face is the point,
and it fell out of the trait grid rather than being contrived.

The build refuses to treat a trait as rarity-bearing if every token's value is
unique, because a "1 of 20" drawn from a trait that is unique by construction
reads as significant and says nothing.

## Binding Names to Figures (V274 / #1078) — superseded

> **This section describes the earlier design and is kept for the reasoning in
> it.** Figures are no longer awarded with a name. They are a separate purchase:
> **5 USDC, and only to an address that already holds a Veil name**, with the
> buyer choosing which of the twenty they want. `bindClaimToFigure` and the
> `Name` trait still work and are still tested — a figure *can* be bound to a
> name — but nothing awards one automatically, and `contracts/veil-masquerade`
> has no concept of claim order.
>
> What survives unchanged is the argument about #09 below: it is sold like the
> other nineteen, with no reserve and no discretion.

The first twenty names claimed through Veil get the twenty Masquerade figures in sequence:
- Claim #1 gets Veil Masquerade #01.
- Claim #2 gets Veil Masquerade #02.
- ...
- Claim #20 gets Veil Masquerade #20.
- **The 21st claimant gets a name and no figure**, and is told so before paying.

### Permanent Binding & The `Name` Trait
When a figure is claimed:
1. Claim order maps directly to the figure number (1..20), and this binding is **permanent** — it cannot be reassigned or transferred to another figure afterwards.
2. The `Name` trait is recorded into the token's metadata (`traits.json` and `metadata/NN.json`) at claim time:
   ```json
   {
     "trait_type": "Name",
     "value": "alice*useveilapp.xyz"
   }
   ```
3. Because every name is unique, `Name` is counted as an **identity trait** (alongside Crown and Ornament), preserving counted rarity for the shared traits (Aperture, Palette, Hem). `build-nft-metadata.mjs --check` verifies metadata consistency with the `Name` trait present.

### Product Decision: Allocation of Masquerade #09
Masquerade #09 is the only closed mask in the set (`Aperture: None`). We deliberately evaluated whether #09 should be special-cased (e.g. reserved or auctioned) or awarded to the ninth claimant.

**Decision: Masquerade #09 strictly goes to the ninth claimant in sequence.**

**Rationale:**
1. The collection's value is proof of earliness: numbering 1..20 is the exact proof of being among the first twenty users.
2. The closed mask feature emerged organically from the trait matrix rather than being artificial scarcity.
3. Trustless first-come first-served issuance is the core promise of Veil's name claim flow; special-casing or reserving #09 would introduce administrative discretion and break the claim order invariant.

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

1. ~~**A contract.**~~ Done: `contracts/veil-masquerade`. Twenty fixed ids, no
   mint function beyond them, 5 USDC to the treasury, and a buyer must already
   hold a Veil name. Upgradeable, unlike the wallet, because the tokens live in
   it and a second deployment would start empty.
2. ~~**Hosting.**~~ Done, with a caveat: the collection is served from
   `app.useveilapp.xyz`, not IPFS. That is a real deployment rather than a
   placeholder, and it is reversible — pin `art/` and the twenty JSON files,
   put the CID in `image-base.txt`, rebuild, and call `set_base_uri`. The
   contract has that function for exactly this reason.
3. **Final art, if the collection is sold on exclusivity** — see *Rights*
   above. These are the AI-generated images at full resolution (1088×1456).
   The *token* supply is provably twenty; the *image* is not provably
   exclusive, and those are different promises. Nothing in the listing claims
   the second one.
4. **Deploy and initialize.** The contract is built and tested but not on
   mainnet. `initialize` takes the admin, USDC, the treasury, the names
   registry (`CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4`) and
   the base URI.
