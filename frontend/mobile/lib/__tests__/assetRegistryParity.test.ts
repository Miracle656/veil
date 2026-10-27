import { StrKey } from '@stellar/stellar-sdk';

import { ALL_REGISTERED_ASSETS } from '../../../../packages/agent/src/assets';
import { ASSET_REGISTRY as walletRegistry } from '../../../../frontend/wallet/lib/assets';
import { ASSET_REGISTRY as mobileRegistry } from '../assets';

const registries = { wallet: walletRegistry, mobile: mobileRegistry };

function expectRegistryCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

describe('asset registry parity', () => {
  it('keeps codes and issuers identical across wallet, mobile, and agent', () => {
    const agentRegistry: Record<string, { issuer: string }> = {};
    for (const entry of ALL_REGISTERED_ASSETS) {
      if (entry.network === 'mainnet') {
        agentRegistry[entry.asset.code] = { issuer: entry.asset.issuer };
      }
    }

    const codes = [
      ...new Set([
        ...Object.keys(registries.wallet),
        ...Object.keys(registries.mobile),
        ...Object.keys(agentRegistry),
      ]),
    ].sort();

    for (const code of codes) {
      const walletAsset: any = walletRegistry[code];
      const mobileAsset: any = mobileRegistry[code];
      const agentAsset: any = agentRegistry[code];

      expectRegistryCondition(Boolean(walletAsset), code + ' is missing from the wallet registry');
      expectRegistryCondition(Boolean(mobileAsset), code + ' is missing from the mobile registry');
      expectRegistryCondition(Boolean(agentAsset), code + ' is missing from the agent registry');
      expectRegistryCondition(
        mobileAsset?.issuer === walletAsset?.issuer,
        code + ' issuer diverges in the mobile registry: ' + mobileAsset?.issuer + ' != ' + walletAsset?.issuer,
      );
      expectRegistryCondition(
        agentAsset?.issuer === walletAsset?.issuer,
        code + ' issuer diverges in the agent registry: ' + agentAsset?.issuer + ' != ' + walletAsset?.issuer,
      );
    }
  });

  it('contains only valid Stellar account issuers', () => {
    for (const [registryName, registry] of Object.entries(registries)) {
      for (const [code, asset] of Object.entries(registry)) {
        const a: any = asset;
        expectRegistryCondition(
          StrKey.isValidEd25519PublicKey(a.issuer),
          registryName + ' registry has an invalid issuer for ' + code + ': ' + a.issuer,
        );
      }
    }

    for (const entry of ALL_REGISTERED_ASSETS) {
      if (entry.network === 'mainnet') {
        expectRegistryCondition(
          StrKey.isValidEd25519PublicKey(entry.asset.issuer),
          'agent registry has an invalid issuer for ' + entry.asset.code + ': ' + entry.asset.issuer,
        );
      }
    }
  });
});

