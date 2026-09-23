import type { VeilNetworkName } from "./network";

export type RegisteredAsset = {
  code: string;
  issuer: string;
  name: string;
  issuerName: string;
};

const REGISTERED: Record<VeilNetworkName, RegisteredAsset[]> = {
  testnet: [
    {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      name: "USD Coin",
      issuerName: "Circle",
    },
  ],
  mainnet: [
    {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      name: "USD Coin",
      issuerName: "Circle",
    },
    {
      code: "USDY",
      issuer: "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6",
      name: "USDY",
      issuerName: "Ondo",
    },
  ],
};

export type AssetVerification = {
  verified: boolean;
  impersonates: RegisteredAsset | null;
};

export function verifyAsset(
  code: string,
  issuer: string,
  network: VeilNetworkName,
): AssetVerification {
  const registered = REGISTERED[network].find((asset) => asset.code === code);
  if (!registered) return { verified: false, impersonates: null };
  return registered.issuer === issuer
    ? { verified: true, impersonates: null }
    : { verified: false, impersonates: registered };
}
