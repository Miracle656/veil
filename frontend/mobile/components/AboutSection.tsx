import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  EXTERNAL_LINKS,
  explorerAddressUrl,
  getAppVersion,
  getContractEntries,
  getNetworkFacts,
  openExternalUrl,
  type ContractEntry,
  type ExternalLink,
} from "../lib/about";
import { getWalletAddress } from "../lib/walletStore";
import { colors } from "../theme/colors";
import { fontFamily } from "../theme/typography";
import { AddressChip, Card } from "./ui";

/**
 * The About section of settings: which build is installed, which network and
 * contracts it is pointed at, and the links a user needs when something looks
 * wrong. Read-only by design — it is the transparency and support surface, not a
 * place where anything can be changed.
 */
export function AboutSection() {
  const version = getAppVersion();
  const networkFacts = getNetworkFacts();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // The wallet address lives in the keychain, so it arrives after first paint.
  useEffect(() => {
    let active = true;
    getWalletAddress()
      .then((address) => {
        if (active) setWalletAddress(address);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const contracts = getContractEntries(walletAddress);

  async function handleOpen(url: string) {
    setLinkError(null);
    const opened = await openExternalUrl(url);
    if (!opened) setLinkError("Could not open that link on this device.");
  }

  return (
    <View style={styles.sections}>
      <Card style={styles.card}>
        <Text style={styles.label}>VERSION</Text>
        <Text style={styles.version}>{version.version}</Text>
        <Text style={styles.caption}>
          {version.build ? `Build ${version.build}` : "Development build"}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>NETWORK</Text>
        {networkFacts.map((fact) => (
          <View key={fact.key} style={styles.factRow}>
            <Text style={styles.factLabel}>{fact.label}</Text>
            <Text style={styles.factValue} numberOfLines={1} ellipsizeMode="middle">
              {fact.value}
            </Text>
          </View>
        ))}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>CONTRACTS</Text>
        {contracts.map((contract) => (
          <ContractRow key={contract.key} contract={contract} onOpen={handleOpen} />
        ))}
      </Card>

      <Card style={styles.linkCard}>
        {EXTERNAL_LINKS.map((link, i) => (
          <LinkRow key={link.key} link={link} divided={i > 0} onOpen={handleOpen} />
        ))}
      </Card>

      {linkError && <Text style={styles.error}>{linkError}</Text>}
    </View>
  );
}

function ContractRow({
  contract,
  onOpen,
}: {
  contract: ContractEntry;
  onOpen: (url: string) => void;
}) {
  const explorerUrl = explorerAddressUrl(contract.address);

  return (
    <View style={styles.contractRow}>
      <Text style={styles.factLabel}>{contract.label}</Text>
      {contract.address ? (
        <View style={styles.contractValue}>
          <AddressChip address={contract.address} label={truncateMiddle(contract.address)} />
          {explorerUrl && (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`View ${contract.label} on stellar.expert`}
              onPress={() => onOpen(explorerUrl)}
              style={styles.explorerLink}
            >
              <Text style={styles.explorerLinkText}>Explorer</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <Text style={styles.factValue}>Not configured</Text>
      )}
    </View>
  );
}

function LinkRow({
  link,
  divided,
  onOpen,
}: {
  link: ExternalLink;
  divided: boolean;
  onOpen: (url: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${link.label}, opens in a browser`}
      accessibilityHint={link.description}
      onPress={() => onOpen(link.url)}
      style={({ pressed }) => [
        styles.linkRow,
        divided && styles.linkRowDivider,
        pressed && styles.linkRowPressed,
      ]}
    >
      <View style={styles.linkText}>
        <Text style={styles.linkLabel}>{link.label}</Text>
        <Text style={styles.linkDescription}>{link.description}</Text>
      </View>
      <Text style={styles.linkChevron}>↗</Text>
    </Pressable>
  );
}

/** Keep both ends of an address visible — enough to verify it by eye. */
function truncateMiddle(address: string): string {
  return address.length <= 18 ? address : `${address.slice(0, 8)}…${address.slice(-8)}`;
}

const styles = StyleSheet.create({
  sections: {
    gap: 16,
  },
  card: {
    padding: 16,
    gap: 10,
  },
  linkCard: {
    padding: 0,
  },
  label: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: "rgba(246,247,248,0.4)",
  },
  version: {
    fontFamily: fontFamily.heading,
    fontSize: 26,
    color: colors.offWhite,
  },
  caption: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: -6,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  factLabel: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  factValue: {
    flex: 1,
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.offWhite,
    textAlign: "right",
  },
  contractRow: {
    gap: 8,
  },
  contractValue: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  explorerLink: {
    paddingVertical: 4,
  },
  explorerLinkText: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.teal,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  linkRowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDim,
  },
  linkRowPressed: {
    backgroundColor: colors.surfaceMd,
  },
  linkText: {
    flex: 1,
  },
  linkLabel: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 15,
    color: colors.offWhite,
  },
  linkDescription: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    color: "rgba(246,247,248,0.4)",
    marginTop: 3,
  },
  linkChevron: {
    fontSize: 16,
    color: colors.gold,
  },
  error: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: "#f87171",
  },
});
