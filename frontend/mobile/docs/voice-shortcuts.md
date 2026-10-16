# Siri phrase test notes

Veil exposes two read-only iOS App Shortcuts through `withIosAppShortcuts`:

| Intent | Standard English | Nigerian English / Pidgin | Expected result |
| --- | --- | --- | --- |
| Balance | “What is my balance?”, “How much do I have?”, “Show me my balance” | “How much I get?”, “Wetin be my balance?” | Opens the balance screen |
| XLM price | “What is the XLM price?”, “How much is XLM?”, “Check the price of XLM” | “How much is Lumens?” | Opens the XLM price screen |

The generated phrases include `in \(.applicationName)` for Siri's app-specific
disambiguation. The short forms remain natural when spoken with “in Veil” at
the end; iOS may also recognize them without the app name when the shortcut is
unambiguous.

## Verification

The phrase list is covered by the plugin unit test. Device recognition must be
checked in an iOS 16+ development build because Expo Go cannot load App Intents.
The following matrix is the manual check to record for each build:

| Phrase | Recognized | Notes |
| --- | --- | --- |
| What is my balance? | ☐ | |
| How much do I have? | ☐ | |
| How much I get? | ☐ | |
| Wetin be my balance? | ☐ | |
| What is the XLM price? | ☐ | |
| How much is Lumens? | ☐ | |

No shortcut performs signing, sends funds, reads key material, or changes
wallet state.
