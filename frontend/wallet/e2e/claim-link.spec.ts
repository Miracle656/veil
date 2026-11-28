import { test, expect } from '@playwright/test'
import { Keypair } from '@stellar/stellar-sdk'

import { USDC_TESTNET_ISSUER } from '../lib/assets'

test.use({ serviceWorkers: 'block' })

const SENDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3))
const EPHEMERAL = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4))
const FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5))
const FAKE_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey()
const BALANCE_ID = '00000000' + 'ab'.repeat(32)

test.describe('Web /claim route safety', () => {
  test('labels impostor USDC as unverified with no icon, and shows icon for registered USDC', async ({
    page,
  }) => {
    let currentIssuer = FAKE_ISSUER

    await page.addInitScript(
      ({ secret }) => {
        localStorage.setItem('veil_network', 'testnet')
        localStorage.setItem('invisible_wallet_address', 'C_TEST_WALLET')
        sessionStorage.setItem('veil_signer_secret', secret)
      },
      { secret: FEE_PAYER.secret() },
    )

    await page.route('https://horizon-testnet.stellar.org/claimable_balances/**', (route) =>
      route.fulfill({
        json: {
          id: BALANCE_ID,
          asset: `USDC:${currentIssuer}`,
          amount: '25.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } }],
        },
      }),
    )

    await page.goto(
      `/claim/${BALANCE_ID}?network=testnet&note=Dinner#s=${encodeURIComponent(EPHEMERAL.secret())}`,
    )

    await expect(page.getByTestId('web-claim-verification-badge')).toHaveText('Unverified asset')
    await expect(page.getByTestId('web-claim-unverified-warning')).toBeVisible()
    await expect(page.locator('main img')).toHaveCount(0)

    currentIssuer = USDC_TESTNET_ISSUER
    await page.reload()
    await expect(page.getByTestId('web-claim-verification-badge')).toContainText('Verified asset')
    await expect(page.locator('main img')).toHaveCount(1)
  })

  test('does not say claimed on a mistyped balance id or a network mismatch', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('veil_network', 'testnet')
    })

    await page.route('https://horizon-testnet.stellar.org/claimable_balances/**', (route) => {
      if (route.request().url().endsWith('/operations?order=desc&limit=10')) {
        return route.fulfill({ json: { _embedded: { records: [] }, records: [] } })
      }
      return route.fulfill({ status: 404, json: { status: 404, title: 'Resource Missing' } })
    })

    // Mistyped ID on matching network -> not_found, never "already claimed"
    await page.goto(`/claim/${BALANCE_ID}?network=testnet#s=${encodeURIComponent(EPHEMERAL.secret())}`)
    await expect(page.getByTestId('web-claim-not-found')).toBeVisible()
    await expect(page.locator('main')).not.toContainText('already been claimed')

    // Mainnet link opened while wallet is set to testnet -> network_mismatch
    await page.goto(`/claim/${BALANCE_ID}?network=mainnet#s=${encodeURIComponent(EPHEMERAL.secret())}`)
    await expect(page.getByTestId('web-claim-network-mismatch')).toBeVisible()
    await expect(page.getByTestId('web-claim-switch-network')).toBeVisible()
  })
})
