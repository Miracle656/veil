# Veil mascot — direction

_Written 2026-10-03. Drawn 2026-10-06, twice — see **Round one** and **Round
two** at the end. The direction below stands; the shape is settled, the aperture
is not._

## Start from what exists

The mark is already strong and the mascot has to descend from it, not sit beside it.

**The Drape** (`frontend/mobile/components/VeilLogo.tsx`): three rounded bars,
widths 52 → 40 → 28, opacity 1.0 → 0.5 → 0.22, on a 96×96 viewBox. Fabric
falling. It also carries a second reading — the layers of the stack, fiat on top,
USDC beneath, yield under that, with only the top layer fully opaque.

| Token | Value | Role |
| --- | --- | --- |
| `accent` | `#FDDA24` | the gold; the mark is drawn in it |
| `background` | `#0F0F0F` | near-black, not pure |
| `label` | `#D6D2C4` | warm bone |
| `lilac` | `#B7ACE8` | unspoken-for; a candidate for a private-mode state |
| `positive` | `#00A7B5` | already means "good outcome" — do not reuse |

Type: Lora 600 italic (headings), Anton caps + 0.08em (accents), Inter (body),
Inconsolata (addresses).

## The direction: a masquerade

A small hovering figure whose entire body is cloth. The three bars of the Drape
become one continuous falling drape with the same taper and the same fade toward
the hem. No limbs. No face.

### Why this one

**It is already the logo.** The mascot and the mark share geometry, so the 22px
header mark and the character read as the same object. Most crypto mascots are
bolted onto a wordmark they have nothing to do with; this one cannot be, because
it is the wordmark's mark standing up.

**It is Nigerian rather than generic.** The masquerade — Egungun among the
Yoruba, Mmanwu among the Igbo — is a cloth-covered presence that is
*ceremonially legitimate*. That is precisely the brand problem: Veil needs
privacy to read as sanctioned, not furtive. A rooted figure does work that a
Western "privacy animal" cannot, and it matches where the product is actually
going — naira rails, airtime, a fiat-facing neobank for Nigerian users.

**No face is the point.** A veil with features defeats itself. Expression comes
from posture and how the cloth hangs: leaning in, drifting, settling. This also
avoids the cute-crypto-animal trap, which is the default failure mode here.

### What was rejected, and why

| Option | Why not |
| --- | --- |
| A ghost | Snapchat owns the silhouette, and "your money vanished" is the worst available read for a wallet. |
| Owl, fox, chameleon, pangolin | Privacy-coin cliché, and disconnected from the Drape. A mammal mascot would make the logo look like a leftover. |
| A lock or shield character | Literal, and shields read as security theatre rather than security. |

## Constraints to hold it to

- **Single-colour SVG**, as `VeilLogo.tsx` is today. If it needs two colours to
  read, the silhouette is wrong.
- **Legible at 22px** — the size the mark renders at in the dashboard header.
  Silhouette first; details earn their place only above ~64px.
- **Keep the taper.** Widest at the shoulder, narrowing to the hem, hem at ~0.22
  opacity. That taper is what makes it the same object as the logo.
- **It hangs; it does not walk.** Any motion is sway and settle — cloth, not a
  character rig. No walk cycle, ever.
- Gold on near-black is the hero. `lilac` is the only free token if a second
  state is ever needed; `positive` teal is spoken for.

## The caution, stated plainly

Masquerade figures are sacred in Yoruba and Igbo practice, not decorative.
Borrowing the **cloth language and silhouette** is fair and reads as rooted.
Depicting a recognisable specific Egungun, or putting the figure in a jokey pose,
would be a real misstep.

Before this goes anywhere public — app icon, store listing, marketing — it should
be run past someone Nigerian whose judgement on this is trusted. That is cheaper
to do now than after it ships on an icon.

## Round one — drawn 2026-10-06

Silhouette studies: <https://claude.ai/artifact/THHzrRWB9brFQ1UpFb1tUx> (private).
Five artboards — the 22px test, the derivation, a hem x taper matrix, the
aperture options, and a picker showing each in the real dashboard header.

### What the drawing found

**The mark already contains the figure.** The three bars' outer corners sit at
(22,32) (74,32) / (28,50) (68,50) / (34,68) (62,68). A straight edge from
(74,32) to (62,68) passes through all three: half-width 26, 20, 14 — the mark's
52, 40 and 28, exactly. Dome that and close it with a hem and the figure is the
mark's own outline, with no proportion invented. The taper constraint above is
satisfied by construction rather than by eye.

That is a sharper claim than "keep the taper" was. An earlier draft anchored the
shoulders at y=36 and missed the middle bar by two pixels — at which point the
figure is merely mark-*like*, which is much weaker. `mascotGeometry.ts` pins all
three widths in a test so it cannot drift back.

**The fade does not survive being shrunk.** At 22px the hem at 0.22 opacity on
near-black is effectively invisible, so the faded figure reads shorter and
rounder than the solid one — a different silhouette depending on the size it is
drawn at, which is the one thing a mark cannot do. The mark itself escapes this
because three detached bars still read as three bars however faint the last one
is; a continuous body simply loses its hem. **So the figure is solid below 32px
and fades above it.** That rule was not in the original direction and belongs in
it.

### Settled

| Question | Decision |
| --- | --- |
| Taper | Logo-exact — the edge through all three bar corners |
| Hem | At y=68, where the mark's own last bar ends |
| Small sizes | Solid under 32px; the 1.0 / 0.5 / 0.22 fade above |

### Open

**The aperture.** Four candidates, all cloth *removed* rather than features
added: none, two slits, one slot, a woven band of three. The picker board shows
each at header size. This one is taste, and it carries the cultural weight, so
it is not a decision to make from outside.

### Built, deliberately unwired

- `frontend/wallet/lib/mascotGeometry.ts` and
  `frontend/mobile/lib/mascotGeometry.ts` — the shape, byte-identical, with a
  parity test
- `frontend/wallet/components/ui/VeilMascot.tsx` and
  `frontend/mobile/components/VeilMascot.tsx` — `aperture` is a prop, so all
  four render without another branch

**Nothing user-facing imports either component.** The caution above still holds:
a read from someone Nigerian whose judgement is trusted comes before an app
icon, a store listing or marketing, and it is cheaper now than after it ships.

## Round two — the first figure was a lightbulb

Round one derived the outline from the mark's corners and domed over the top.
Mathematically faithful, and it read as a **lightbulb**. The geometry was not
wrong; a single convex curve simply is not fabric, whatever it is derived from.
Worth writing down, because the derivation felt like enough and was not.

Two changes fixed it, and both are load-bearing:

- **The widest point is the shoulder, not the head.** The crown is 28 across —
  the hem's width — and the cloth spreads out from it to the mark's full 52 at
  y=32. A figure whose head is its widest part is a bulb.
- **The hem is uneven.** Three scallops rather than one smooth belly. A smooth
  edge reads as a solid object; a broken one reads as cloth hanging.

Three candidates went up: hooded, peaked, layered. Hooded and layered both
landed — and they turned out not to be alternatives.

### Hooded and layered are one figure

The layered version is the hooded outline with two seams cut **across** it,
not three shapes stacked beside each other. The bands run the full width of the
box and are clipped to the outline, so their union is exactly the silhouette:
the detailed figure cannot grow a different edge from the plain one, however the
seams are redrawn. The seams are scalloped like the hem, and carry the mark's
own 1.0 / 0.5 / 0.22.

So there is one figure with two levels of detail, which is what this doc already
asked for — silhouette first, details only above about 64px:

| Size | What it draws |
| --- | --- |
| under 64px | one solid shape |
| 64px and up | the same outline, seamed |

That replaces round one's solid-under-32px rule, for the same reason: a mark
that gains and loses parts as it is resized is not one mark.

### Still settled from round one

The falling edge runs (74,32) to (62,68) and passes through all three bar
widths exactly — 52 at y32, 40 at y50, 28 at y68. Tested, so it cannot drift.

### Still open

**The aperture.** Now to be judged against the hooded crown, which is 26 across
at y=17 and 20 at y=12 — far less room than the bulb had. The four options are
re-placed against it and the test measures the crown's own curve rather than
extrapolating the body's taper, which would have passed an opening hanging off
the edge.

## Next step

Pick an aperture against the hooded crown. Then the sway-and-settle motion
study, and the read.
