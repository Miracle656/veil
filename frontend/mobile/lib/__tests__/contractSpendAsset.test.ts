/**
 * The SAC id a contract spend targets must follow the asset being sent.
 *
 * This is the whole of what made "spend USDC from the smart wallet" impossible:
 * the transfer was built against a hardcoded native SAC, so an issued asset
 * either moved the wrong token or was rejected outright. Nothing on-chain had
 * to change — `__check_auth` never inspects the asset — so a regression here
 * would look like a client bug with no contract-side signal at all.
 */
import { Asset, Networks } from '@stellar/stellar-sdk';

// Circle's USDC on mainnet, and the contract Horizon reports for it. Pinned as
// a literal so a wrong derivation cannot quietly agree with itself.
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_SAC_PUBLIC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

describe('SAC id derivation for contract spends', () => {
  it('derives the USDC contract Horizon actually reports', () => {
    const usdc = new Asset('USDC', USDC_ISSUER);
    expect(usdc.contractId(Networks.PUBLIC)).toBe(USDC_SAC_PUBLIC);
  });

  it('does not confuse an issued asset with native', () => {
    const usdc = new Asset('USDC', USDC_ISSUER);
    expect(usdc.contractId(Networks.PUBLIC)).not.toBe(
      Asset.native().contractId(Networks.PUBLIC),
    );
  });

  it('is network-scoped, so a testnet id never addresses mainnet', () => {
    expect(Asset.native().contractId(Networks.PUBLIC)).not.toBe(
      Asset.native().contractId(Networks.TESTNET),
    );
  });

  it('resolves the same asset consistently', () => {
    const a = new Asset('USDC', USDC_ISSUER).contractId(Networks.PUBLIC);
    const b = new Asset('USDC', USDC_ISSUER).contractId(Networks.PUBLIC);
    expect(a).toBe(b);
  });
});
