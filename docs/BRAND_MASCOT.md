# Veil mascot — direction

_Written 2026-10-03. A direction, not a decision. Nothing here has been drawn yet._

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

## Next step

Silhouette studies before anything else: hem length, taper rate, with and
without any suggestion of eyes, rendered at 22px and large on `#0F0F0F`. The
22px test is what kills most mascots, so it should come first rather than last.
