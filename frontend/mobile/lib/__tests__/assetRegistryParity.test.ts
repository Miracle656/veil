import { StrKey } from '@stellar/stellar-sdk';

import { ASSET_REGISTRY as agentRegistry } from '../../../../packages/agent/src/assets';
import { ASSET_REGISTRY as walletRegistry } from '../../../../frontend/wallet/lib/assets';
import { ASSET_REGISTRY as mobileRegistry } from '../assets';

const registries = { wallet: walletRegistry, mobile: mobileRegistry, agent: agentRegistry };

function expectRegistryCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

describe('asset registry parity', () => {
  it('keeps codes and issuers identical across wallet, mobile, and agent', () => {
    const codes = [...new Set(Object.values(registries).flatMap((registry) => Object.keys(registry)))].sort();

    for (const code of codes) {
      const walletAsset = walletRegistry[code];
      const mobileAsset = mobileRegistry[code];
      const agentAsset = agentRegistry[code];

      expectRegistryCondition(Boolean(walletAsset), `${code} is missing from the wallet registry`);
      expectRegistryCondition(Boolean(mobileAsset), `${code} is missing from the mobile registry`);
      expectRegistryCondition(Boolean(agentAsset), `${code} is missing from the agent registry`);
      expectRegistryCondition(
        mobileAsset?.issuer === walletAsset?.issuer,
        `${code} issuer diverges in the mobile registry: ${mobileAsset?.issuer} != ${walletAsset?.issuer}`,
      );
      expectRegistryCondition(
        agentAsset?.issuer === walletAsset?.issuer,
        `${code} issuer diverges in the agent registry: ${agentAsset?.issuer} != ${walletAsset?.issuer}`,
      );
    }
  });

  it('contains only valid Stellar account issuers', () => {
    for (const [registryName, registry] of Object.entries(registries)) {
      for (const [code, asset] of Object.entries(registry)) {
        expectRegistryCondition(
          StrKey.isValidEd25519PublicKey(asset.issuer),
          `${registryName} registry has an invalid issuer for ${code}: ${asset.issuer}`,
        );
      }
    }
  });

});