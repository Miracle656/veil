# Wave batch — web navigation (V294)

Drafted 2026-10-15 from a user report: on a phone, the web wallet's top bar is
ten glyphs and nothing else, and there is no way to tell what any of them does.

## Shared with every issue

**Repo:** `Miracle656/veil`. The web wallet is `frontend/wallet` (Next.js); the mobile app is `frontend/mobile` (Expo / React Native). They share an SDK in `sdk/`.

**Run the tests:** `npm test` in `frontend/wallet`. Two suites (`csp.test.ts`, `registryParity.test.ts`) are red on the `feat/buy-with-naira` branch and green on `main`; if you are working from the branch, that is V283's job and not yours.

**This wallet holds real money on mainnet.** Navigation is the one surface every user touches before they touch anything else, so a wrong destination here is a user sending money from a screen they did not mean to open.

**Never elide an address in code or docs.** A previous batch wrote `CD2W5LUR…XZ4L` in an issue and five contributors invented plausible-looking contract ids to fill the gap. Write the whole thing or do not write it.

---

### V294 · On a phone the web wallet's top bar is ten unlabelled glyphs

**Labels:** help wanted, Stellar Wave, area:web, difficulty:intermediate, epic:design

### Background

Below the `lg` breakpoint, `frontend/wallet/components/AppShell.tsx` renders a compact header containing every one of the ten main destinations as a bare character:

```
⌂  ↗  ↙  ⇅  ⇰  ⇲  ◎  ▤  ◈  ✦
```

That is Home, Send, Receive, Swap, Buy with naira, Cash out, Earn, Bills & airtime, dApps and Agent. A user who has not memorised the order cannot tell which is which, and a user reported exactly that.

Four separate things are wrong, and it is worth knowing which is which before changing anything:

1. **No visible label and no tooltip.** The rail at `lg` and above renders `{item.icon}` *and* `{item.label}`. The compact header renders only `{item.icon}`. It does set `aria-label`, so a screen reader announces the destination correctly — a sighted user gets nothing, and there is no `title` attribute, so there is no hover tooltip either. This is the rare case where the accessible experience is better than the visual one.

2. **The glyphs are Unicode characters, not icons.** `⌂ ↗ ↙ ⇅ ⇰ ⇲ ◎ ▤ ◈ ✦` are literal strings in the `NAV_MAIN` array. Their appearance depends entirely on which font the device falls back to; `⇰` (U+21F0) and `⇲` (U+21F2) have thin coverage and render as a box on some Android font stacks. The app already depends on `lucide-react` and already uses it elsewhere.

3. **One glyph, two destinations.** `◈` is `/dapps` in `NAV_MAIN` and `/multisig` in `NAV_MULTISIG`. When the multisig entry is shown, the bar contains the same character twice pointing at different pages.

4. **Two navigations at once.** On the same narrow screen, `components/ui/TabBar.tsx` already renders a bottom bar of five destinations — Home, Assets, Swap, Agent, Settings — each a `lucide` icon with a visible text label beneath it, correctly marked `aria-hidden` on the glyph so the label is the accessible name. **That component is the house pattern and it is already right.** The top strip is a second, worse navigation sitting above it, and the two do not agree on what the primary destinations are.

The reporter suggested a hamburger or a side drawer, which is one good answer; this issue does not mandate which.

### What to build

Pick one structure and make the narrow-screen navigation that structure, rather than adding labels to a bar that should probably not hold ten items:

- **A drawer**, opened from a single labelled control in the header, listing every destination with a lucide icon *and* its text — essentially the `lg` rail, revealed on demand. Keep the bottom `TabBar` for the five frequent destinations.
- **Or** keep a horizontal strip, but with text under each glyph the way `TabBar` does it, which means admitting it cannot hold ten and deciding which belong there.

Either way:

- Replace the Unicode glyphs with `lucide-react` icons, as `TabBar` does. One icon per destination, no duplicates.
- Whatever carries the accessible name must be visible. If the label is on screen, the glyph is `aria-hidden` and the text is the name — copy `TabBar`'s comment and approach rather than inventing a second convention.
- A drawer must trap focus, close on `Escape` and on backdrop click, restore focus to the control that opened it, and mark that control `aria-expanded`.
- The current bar is `overflow-x-auto` with no scroll affordance, so items past the right edge are invisible with nothing hinting they exist. Whatever replaces it must not hide destinations off-screen.
- The active destination must still be obvious, and still set `aria-current="page"`.

### Acceptance criteria

- [ ] Every navigation destination on a narrow viewport is identifiable without prior knowledge — a visible word, not a glyph alone
- [ ] No Unicode glyph is used as an icon anywhere in `AppShell.tsx`; `lucide-react` throughout
- [ ] No two destinations share an icon
- [ ] No destination is reachable only by horizontally scrolling a strip with no affordance
- [ ] A drawer, if that is the route taken, traps focus, closes on `Escape` and backdrop click, restores focus on close, and sets `aria-expanded` on its trigger
- [ ] The active destination is visually distinct and sets `aria-current="page"`
- [ ] The top navigation and the bottom `TabBar` do not present two competing answers to "where can I go"
- [ ] A test covers the narrow-screen navigation: every destination is present and has an accessible name matching its visible text

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
