"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Horizon,
  Keypair,
  rpc as SorobanRpc,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Asset,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
const Server = Horizon.Server;
import { TxDetailSheet, type TxRecord } from "@/components/TxDetailSheet";
import { useInactivityLock } from "@/hooks/useInactivityLock";
import { deriveStoredFeePayer } from "@/lib/deriveFeePayer";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletAsset {
  code: string;
  issuer: string | null;
  balance: string;
}

// ── Dashboard page ────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();
  useInactivityLock();

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [transactions, setTransactions] = useState<TxRecord[]>([]);
  const [selectedTx, setSelectedTx] = useState<TxRecord | null>(null);
  const [txFilter, setTxFilter] = useState<"all" | "transfers" | "swaps">(
    "all",
  );
  const [loading, setLoading] = useState(true);
  const [isFunding, setIsFunding] = useState(false);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasFeePayerKey, setHasFeePayerKey] = useState(true);
  const [agentBadge, setAgentBadge] = useState(false);
  const [wraithIncomingCursor, setWraithIncomingCursor] = useState<
    string | null
  >(null);
  const [wraithOutgoingCursor, setWraithOutgoingCursor] = useState<
    string | null
  >(null);
  const [wraithAvailable, setWraithAvailable] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const isTestnet = process.env.NEXT_PUBLIC_NETWORK === "testnet";

  useEffect(() => {
    const stored = sessionStorage.getItem("invisible_wallet_address");
    if (!stored) {
      router.replace("/lock");
      return;
    }
    setWalletAddress(stored);

    // Ensure veil_signer_secret is in localStorage so it survives lock/unlock.
    // Wallets created before this fix only had it in sessionStorage.
    const secret = sessionStorage.getItem("veil_signer_secret");
    if (secret && !localStorage.getItem("veil_signer_secret")) {
      localStorage.setItem("veil_signer_secret", secret);
    }
  }, [router]);

  const WRAITH_URL = process.env.NEXT_PUBLIC_WRAITH_URL;

  const fetchWraithPage = async (
    direction: "incoming" | "outgoing",
    address: string,
    cursor: string | null,
  ) => {
    if (!WRAITH_URL) throw new Error("No Wraith URL configured");
    const url = new URL(`${WRAITH_URL}/transfers/${direction}/${address}`);
    url.searchParams.set("limit", "20");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("Wraith transfer request failed");
    return (await res.json()) as {
      transfers: Array<{
        id: number;
        eventType: string;
        fromAddress: string | null;
        toAddress: string | null;
        amount: string;
        ledger: number;
        ledgerClosedAt: string;
        txHash: string;
        contractId: string;
      }>;
      next_cursor?: string | null;
    };
  };

  const fetchData = useCallback(async () => {
    if (!walletAddress) return; // keep loading=true until address is ready
    setLoading(true);
    setWraithAvailable(true);
    setWraithIncomingCursor(null);
    setWraithOutgoingCursor(null);

    const horizonUrl = isTestnet
      ? "https://horizon-testnet.stellar.org"
      : "https://horizon.stellar.org";
    const rpcUrl = isTestnet
      ? "https://soroban-testnet.stellar.org"
      : "https://soroban.stellar.org";

    const horizonServer = new Server(horizonUrl);
    const rpcServer = new SorobanRpc.Server(rpcUrl);

    // ── 1. Wallet contract (C...) XLM balance via native SAC ────────────────
    // This is the canonical on-chain balance — survives cache clears and
    // cross-device recovery because it reads directly from the ledger.
    let contractXlm = 0;
    try {
      const sacAddress = Asset.native().contractId(Networks.TESTNET);
      const sacContract = new Contract(sacAddress);
      const dummyKp = Keypair.random();
      const dummyAcct = new Account(dummyKp.publicKey(), "0");
      const balanceTx = new TransactionBuilder(dummyAcct, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          sacContract.call(
            "balance",
            nativeToScVal(walletAddress, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const sim = await rpcServer.simulateTransaction(balanceTx);
      if (!SorobanRpc.Api.isSimulationError(sim)) {
        const result = (
          sim as SorobanRpc.Api.SimulateTransactionSuccessResponse
        ).result;
        if (result) {
          const stroops = scValToNative(result.retval) as bigint;
          contractXlm = Number(stroops) / 10_000_000;
        }
      }
    } catch {
      /* contract has no balance entry yet */
    }

    // ── 2. Fee-payer G... balance (holds the testnet faucet XLM) ────────────
    const signerSecret = sessionStorage.getItem("veil_signer_secret");
    const signerPublicKey = signerSecret
      ? Keypair.fromSecret(signerSecret).publicKey()
      : localStorage.getItem("veil_signer_public_key") || null;

    // Track whether fee-payer exists so we can show a recovery banner
    setHasFeePayerKey(!!signerPublicKey);

    let feePayerXlm = 0;
    let otherAssets: WalletAsset[] = [];
    let txRecords: TxRecord[] = [];

    if (signerPublicKey) {
      try {
        const account = await horizonServer.loadAccount(signerPublicKey);
        const native = account.balances.find(
          (b: any) => b.asset_type === "native",
        );
        feePayerXlm = native ? parseFloat(native.balance) : 0;

        // All non-XLM balances (e.g. USDC from swaps)
        otherAssets = (account.balances as any[])
          .filter((b) => b.asset_type !== "native" && parseFloat(b.balance) > 0)
          .map((b) => ({
            code: b.asset_code,
            issuer: b.asset_issuer,
            balance: b.balance,
          }));

        // Transaction history (fee-payer account)
        type HorizonOp = {
          id: string;
          type: string;
          from?: string;
          to?: string;
          funder?: string;
          account?: string;
          amount?: string;
          starting_balance?: string;
          asset_type?: string;
          asset_code?: string;
          asset_issuer?: string;
          source_amount?: string;
          source_asset_type?: string;
          source_asset_code?: string;
          created_at: string;
          transaction_hash: string;
          transaction?: { memo?: string };
        };

        const payments = await horizonServer
          .payments()
          .forAccount(signerPublicKey)
          .limit(20)
          .order("desc")
          .call();

        txRecords = (payments.records as HorizonOp[])
          .filter(
            (p) =>
              p.type === "payment" ||
              p.type === "create_account" ||
              p.type === "path_payment_strict_send",
          )
          .map((p) => {
            if (p.type === "create_account") {
              return {
                id: p.id,
                type: "received" as const,
                amount: p.starting_balance ?? "0",
                asset: "XLM",
                counterparty: p.funder ?? "Friendbot",
                timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
                hash: p.transaction_hash,
              };
            }
            if (p.type === "path_payment_strict_send") {
              const srcAsset =
                p.source_asset_type === "native"
                  ? "XLM"
                  : (p.source_asset_code ?? "XLM");
              const dstAsset =
                p.asset_type === "native" ? "XLM" : (p.asset_code ?? "");
              return {
                id: p.id,
                type: "swapped" as const,
                amount: p.source_amount ?? "0",
                asset: srcAsset,
                destAmount: p.amount ?? "0",
                destAsset: dstAsset,
                counterparty: "Stellar DEX",
                timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
                hash: p.transaction_hash,
              };
            }
            return {
              id: p.id,
              type:
                p.from === signerPublicKey
                  ? ("sent" as const)
                  : ("received" as const),
              amount: p.amount ?? "0",
              asset: p.asset_type === "native" ? "XLM" : (p.asset_code ?? ""),
              counterparty:
                p.from === signerPublicKey ? (p.to ?? "") : (p.from ?? ""),
              timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
              hash: p.transaction_hash,
              memo: p.transaction?.memo,
            };
          });
      } catch {
        /* not yet funded */
      }
    }

    // ── 3. Wraith: incoming SAC transfers to the wallet contract ────────────
    const wraithUrl = process.env.NEXT_PUBLIC_WRAITH_URL;
    if (wraithUrl) {
      try {
        type WraithTransfer = {
          id: number;
          eventType: string;
          fromAddress: string | null;
          toAddress: string | null;
          amount: string;
          ledger: number;
          ledgerClosedAt: string;
          txHash: string;
          contractId: string;
        };
        // Incoming: to wallet C... address
        // Outgoing: from fee-payer G... address (sends go from fee-payer, not contract)
        const feePayerAddr = signerPublicKey || walletAddress;
        const [inPage, outPage] = await Promise.all([
          fetchWraithPage("incoming", walletAddress, null),
          fetchWraithPage("outgoing", feePayerAddr, null),
        ]);

        setWraithIncomingCursor(inPage.next_cursor ?? null);
        setWraithOutgoingCursor(outPage.next_cursor ?? null);

        const inData = { transfers: inPage.transfers };
        const outData = { transfers: outPage.transfers };

        const wraithRecords: TxRecord[] = [
          ...inData.transfers.map((t) => ({
            id: `w-${t.id}`,
            type: "received" as const,
            amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
            asset: "XLM",
            counterparty: t.fromAddress ?? "unknown",
            timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
            hash: t.txHash,
          })),
          ...outData.transfers.map((t) => ({
            id: `w-${t.id}`,
            type: "sent" as const,
            amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
            asset: "XLM",
            counterparty: t.toAddress ?? "unknown",
            timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
            hash: t.txHash,
          })),
        ];

        // Merge Wraith records with Horizon records, deduplicate by hash, sort newest first
        const merged = [...wraithRecords, ...txRecords]
          .filter(
            (tx, i, arr) => arr.findIndex((t) => t.hash === tx.hash) === i,
          )
          .sort((a, b) => b.timestamp - a.timestamp);
        txRecords = merged;
      } catch {
        setWraithAvailable(false);
      }
    }

    // ── 4. Check for new incoming transfers → agent notification badge ─────
    const lastVisit = parseInt(
      localStorage.getItem("veil_agent_last_visit") ?? "0",
      10,
    );
    const newIncoming = txRecords.filter(
      (tx) => tx.type === "received" && tx.timestamp * 1000 > lastVisit,
    );
    if (newIncoming.length > 0) {
      const latest = newIncoming[0];
      localStorage.setItem(
        "veil_agent_notification",
        JSON.stringify({
          amount: parseFloat(latest.amount).toFixed(2),
          asset: latest.asset,
          from: latest.counterparty,
          timestamp: latest.timestamp,
        }),
      );
      setAgentBadge(true);
    } else {
      // Check if a stale notification exists
      setAgentBadge(!!localStorage.getItem("veil_agent_notification"));
    }

    // ── 5. Combine and display ───────────────────────────────────────────────
    const totalXlm = (contractXlm + feePayerXlm).toFixed(7);
    setAssets([
      { code: "XLM", issuer: null, balance: totalXlm },
      ...otherAssets,
    ]);
    setTransactions(txRecords);
    setLoading(false);
  }, [walletAddress, isTestnet]);

  const handleLoadMore = useCallback(async () => {
    if (!walletAddress || !WRAITH_URL) return;
    if (!wraithIncomingCursor && !wraithOutgoingCursor) return;

    setIsLoadingMore(true);
    try {
      const signerSecret = sessionStorage.getItem("veil_signer_secret");
      let signerPublicKey = signerSecret
        ? Keypair.fromSecret(signerSecret).publicKey()
        : localStorage.getItem("veil_signer_public_key") || null;
      if (!signerPublicKey) {
        const derived = await deriveStoredFeePayer();
        if (derived) signerPublicKey = derived.publicKey();
      }
      const feePayerAddr = signerPublicKey || walletAddress;

      const [inPage, outPage] = await Promise.all([
        wraithIncomingCursor
          ? fetchWraithPage("incoming", walletAddress, wraithIncomingCursor)
          : Promise.resolve(null),
        wraithOutgoingCursor
          ? fetchWraithPage("outgoing", feePayerAddr, wraithOutgoingCursor)
          : Promise.resolve(null),
      ]);

      if (inPage) setWraithIncomingCursor(inPage.next_cursor ?? null);
      if (outPage) setWraithOutgoingCursor(outPage.next_cursor ?? null);

      const wraithRecords: TxRecord[] = [
        ...(inPage?.transfers ?? []).map((t) => ({
          id: `w-${t.id}`,
          type: "received" as const,
          amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
          asset: "XLM",
          counterparty: t.fromAddress ?? "unknown",
          timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
          hash: t.txHash,
        })),
        ...(outPage?.transfers ?? []).map((t) => ({
          id: `w-${t.id}`,
          type: "sent" as const,
          amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
          asset: "XLM",
          counterparty: t.toAddress ?? "unknown",
          timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
          hash: t.txHash,
        })),
      ];

      setTransactions((prev) => {
        const merged = [...prev, ...wraithRecords]
          .filter(
            (tx, i, arr) => arr.findIndex((t) => t.hash === tx.hash) === i,
          )
          .sort((a, b) => b.timestamp - a.timestamp);
        return merged;
      });
    } catch {
      setWraithAvailable(false);
    } finally {
      setIsLoadingMore(false);
    }
  }, [walletAddress, WRAITH_URL, wraithIncomingCursor, wraithOutgoingCursor]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Re-fetch when user navigates back to this tab/page (e.g. after sending)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchData();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchData]);

  const xlmBalance = assets.find((a) => a.code === "XLM")?.balance ?? null;
  const hasMoreWraithTransfers =
    wraithAvailable && (wraithIncomingCursor || wraithOutgoingCursor);

  const handleFund = async () => {
    setIsFunding(true);
    setFundingError(null);
    try {
      // Friendbot only funds classic G... accounts, not C... contract addresses.
      // Derive the G... public key from session secret or fall back to localStorage.
      const signerSecret = sessionStorage.getItem("veil_signer_secret");
      let signerPublicKey = signerSecret
        ? Keypair.fromSecret(signerSecret).publicKey()
        : localStorage.getItem("veil_signer_public_key") || null;

      // After cache clear or cross-device recovery — derive fee-payer from passkey.
      // Same credential ID always produces the same keypair, so funds are never lost.
      if (!signerPublicKey) {
        const derived = await deriveStoredFeePayer();
        if (!derived)
          throw new Error("No passkey found. Please register again.");
        localStorage.setItem("veil_signer_public_key", derived.publicKey());
        localStorage.setItem("veil_signer_secret", derived.secret());
        sessionStorage.setItem("veil_signer_secret", derived.secret());
        signerPublicKey = derived.publicKey();
      }
      // Always ensure the secret is persisted to localStorage so it survives lock/unlock
      const currentSecret = sessionStorage.getItem("veil_signer_secret");
      if (currentSecret && !localStorage.getItem("veil_signer_secret")) {
        localStorage.setItem("veil_signer_secret", currentSecret);
      }
      const res = await fetch(
        `https://friendbot.stellar.org/?addr=${signerPublicKey}`,
      );
      if (!res.ok) {
        // 400 means the account is already funded — just refresh balances
        if (res.status === 400) {
          await fetchData();
          return;
        }
        throw new Error("Friendbot failed");
      }
      await new Promise((r) => setTimeout(r, 2000));
      await fetchData();
    } catch (err: unknown) {
      setFundingError(
        err instanceof Error
          ? err.message
          : "Funding failed. Please try again.",
      );
    } finally {
      setIsFunding(false);
    }
  };

  return (
    <div className="wallet-shell">
      {/* Header */}
      <header className="wallet-nav">
        <span
          style={{
            fontFamily: "Anton, Impact, sans-serif",
            fontSize: "1.25rem",
            letterSpacing: "0.08em",
            color: "var(--gold)",
            userSelect: "none",
          }}
        >
          VEIL
        </span>
        {walletAddress && (
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(walletAddress);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.375rem",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            title="Copy wallet address"
          >
            <span className="address-chip">
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-6)}
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              style={{
                color: copied ? "var(--teal)" : "rgba(246,247,248,0.35)",
                flexShrink: 0,
              }}
            >
              {copied ? (
                <path
                  d="M20 6L9 17l-5-5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <>
                  <rect
                    x="9"
                    y="9"
                    width="13"
                    height="13"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  />
                  <path
                    d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  />
                </>
              )}
            </svg>
          </button>
        )}
        <button
          onClick={() => router.push("/settings")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "0.25rem",
            color: "var(--warm-grey)",
            display: "flex",
          }}
          title="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="3"
              stroke="currentColor"
              strokeWidth="1.75"
            />
            <path
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <main
        className="wallet-main"
        style={{ paddingTop: "3rem", paddingBottom: "3rem" }}
      >
        <div style={{ marginBottom: "2rem" }}>
          <h1
            style={{
              fontFamily: "Lora, Georgia, serif",
              fontWeight: 600,
              fontStyle: "italic",
              fontSize: "1.75rem",
              color: "var(--off-white)",
              marginBottom: "0.25rem",
            }}
          >
            Dashboard
          </h1>
          <p style={{ fontSize: "0.875rem", color: "rgba(246,247,248,0.5)" }}>
            Your wallet locks automatically after 5 minutes of inactivity.
          </p>
        </div>

        {/* ── Fee-payer missing banner (after cache clear) ── */}
        {!loading && !hasFeePayerKey && (
          <div
            style={{
              marginBottom: "1.5rem",
              padding: "1rem 1.25rem",
              background: "rgba(253,218,36,0.07)",
              border: "1px solid rgba(253,218,36,0.25)",
              borderRadius: "12px",
            }}
          >
            <p
              style={{
                fontSize: "0.875rem",
                color: "var(--off-white)",
                marginBottom: "0.5rem",
                fontWeight: 500,
              }}
            >
              Signing key not found
            </p>
            <p
              style={{
                fontSize: "0.8125rem",
                color: "rgba(246,247,248,0.55)",
                marginBottom: "0.875rem",
                lineHeight: 1.5,
              }}
            >
              Your browser storage was cleared. Tap below to set up a new
              fee-payer account so you can send, swap, and use the agent.
            </p>
            <button
              className="btn-gold"
              onClick={handleFund}
              disabled={isFunding}
              style={{ fontSize: "0.875rem", padding: "0.625rem 1.25rem" }}
            >
              {isFunding ? (
                <div
                  className="spinner"
                  style={{ width: "14px", height: "14px" }}
                />
              ) : (
                "Set up fee-payer"
              )}
            </button>
            {fundingError && (
              <p
                style={{
                  color: "var(--teal)",
                  fontSize: "0.75rem",
                  marginTop: "0.625rem",
                }}
              >
                {fundingError}
              </p>
            )}
          </div>
        )}

        {/* ── Balance Display ── */}
        <div style={{ marginBottom: "2rem" }}>
          <p
            style={{
              fontSize: "0.75rem",
              fontFamily: "Anton, Impact, sans-serif",
              color: "var(--warm-grey)",
              letterSpacing: "0.08em",
              marginBottom: "0.5rem",
            }}
          >
            AVAILABLE BALANCE
          </p>
          {loading ? (
            <div
              className="skeleton"
              style={{ width: "220px", height: "3rem", borderRadius: "8px" }}
            />
          ) : (
            <div
              style={{
                fontFamily: "Lora, Georgia, serif",
                fontWeight: 600,
                fontStyle: "italic",
                fontSize: "2.5rem",
                color: "var(--off-white)",
              }}
            >
              {xlmBalance !== null
                ? `${parseFloat(xlmBalance).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 7 })} XLM`
                : "—"}
            </div>
          )}

          {/* Faucet button for unfunded or zero-balance testnet wallets */}
          {isTestnet &&
            !loading &&
            (xlmBalance === null || xlmBalance === "0") && (
              <div style={{ marginTop: "1.25rem" }}>
                <button
                  className="btn-ghost"
                  onClick={handleFund}
                  disabled={isFunding}
                  style={{
                    width: "auto",
                    paddingLeft: "1.5rem",
                    paddingRight: "1.5rem",
                    minHeight: "3rem",
                  }}
                >
                  {isFunding ? (
                    <div
                      className="spinner spinner-light"
                      style={{ width: "1.25rem", height: "1.25rem" }}
                    />
                  ) : (
                    "Fund with testnet XLM"
                  )}
                </button>
                {fundingError && (
                  <p
                    style={{
                      color: "var(--teal)",
                      fontSize: "0.75rem",
                      marginTop: "0.75rem",
                    }}
                  >
                    {fundingError}
                  </p>
                )}
              </div>
            )}
        </div>

        {/* ── Action Row ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: "0.75rem",
            marginBottom: "2.5rem",
          }}
        >
          <ActionButton
            label="Send"
            onClick={() => router.push("/send")}
            icon={
              <path
                d="M5 12h14M12 5l7 7-7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            }
          />
          <ActionButton
            label="Receive"
            onClick={() => router.push("/receive")}
            icon={
              <path
                d="M19 12H5M12 19l-7-7 7-7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            }
          />
          <ActionButton
            label="Swap"
            onClick={() => router.push("/swap")}
            icon={
              <path
                d="M7 10l5-5 5 5M17 14l-5 5-5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            }
          />
          <ActionButton
            label="Agent"
            onClick={() => {
              localStorage.setItem(
                "veil_agent_last_visit",
                Date.now().toString(),
              );
              setAgentBadge(false);
              router.push("/agent");
            }}
            badge={agentBadge}
            icon={
              <path
                d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zm0 10c-4 0-7 2-7 4v1h14v-1c0-2-3-4-7-4z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            }
          />
        </div>

        {/* ── Assets section ── */}
        <section style={{ marginBottom: "2rem" }}>
          <h2
            style={{
              fontSize: "0.75rem",
              fontFamily: "Anton, Impact, sans-serif",
              color: "var(--warm-grey)",
              letterSpacing: "0.08em",
              marginBottom: "0.75rem",
            }}
          >
            ASSETS
          </h2>
          {loading ? (
            <div
              className="card"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.875rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div
                  className="skeleton"
                  style={{ width: "48px", height: "1.125rem" }}
                />
                <div
                  className="skeleton"
                  style={{ width: "80px", height: "1.125rem" }}
                />
              </div>
            </div>
          ) : assets.length === 0 ? (
            <div
              className="card"
              style={{ textAlign: "center", padding: "2rem" }}
            >
              <p
                style={{ fontSize: "0.875rem", color: "rgba(246,247,248,0.4)" }}
              >
                No assets found. Fund this address on Stellar Testnet to get
                started.
              </p>
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {assets.map((asset, i) => {
                const tokenHref = asset.issuer
                  ? `/token/${asset.code}?issuer=${asset.issuer}`
                  : `/token/${asset.code}`;
                return (
                  <button
                    key={`${asset.code}-${asset.issuer ?? "native"}`}
                    onClick={() => router.push(tokenHref)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      width: "100%",
                      padding: "0.875rem 1.25rem",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--off-white)",
                      borderBottom:
                        i < assets.length - 1
                          ? "1px solid var(--border-dim)"
                          : "none",
                      transition: "background 100ms",
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                      }}
                    >
                      <TokenIcon code={asset.code} size={36} />
                      <div>
                        <p style={{ fontWeight: 500, fontSize: "0.9375rem" }}>
                          {asset.code}
                        </p>
                        <p
                          style={{
                            fontSize: "0.6875rem",
                            color: "rgba(246,247,248,0.35)",
                            marginTop: "0.125rem",
                          }}
                        >
                          {asset.code === "XLM"
                            ? "Stellar Lumens"
                            : asset.code === "USDC"
                              ? "USD Coin"
                              : asset.issuer
                                ? `${asset.issuer.slice(0, 6)}…${asset.issuer.slice(-4)}`
                                : "Token"}
                        </p>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p
                        style={{
                          fontFamily: "Inconsolata, monospace",
                          fontSize: "0.9375rem",
                          fontWeight: 500,
                        }}
                      >
                        {parseFloat(asset.balance).toFixed(2)}
                      </p>
                      <p
                        style={{
                          fontSize: "0.6875rem",
                          color: "rgba(246,247,248,0.35)",
                          marginTop: "0.125rem",
                        }}
                      >
                        {asset.code}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Activity section ── */}
        <section>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.75rem",
            }}
          >
            <h2
              style={{
                fontSize: "0.75rem",
                fontFamily: "Anton, Impact, sans-serif",
                color: "var(--warm-grey)",
                letterSpacing: "0.08em",
              }}
            >
              ACTIVITY
            </h2>
            <button
              onClick={() => fetchData()}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "rgba(246,247,248,0.4)",
                fontSize: "0.75rem",
                display: "flex",
                alignItems: "center",
                gap: "0.375rem",
                padding: "0.25rem",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M1 4v6h6M23 20v-6h-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Refresh
            </button>
          </div>
          {/* Filter pills */}
          <div
            style={{ display: "flex", gap: "0.5rem", marginBottom: "0.875rem" }}
          >
            {(["all", "transfers", "swaps"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setTxFilter(f)}
                style={{
                  padding: "0.3rem 0.875rem",
                  borderRadius: "100px",
                  border: "1px solid",
                  fontSize: "0.75rem",
                  fontFamily: "Inter, sans-serif",
                  cursor: "pointer",
                  transition: "all 120ms",
                  background: txFilter === f ? "var(--gold)" : "transparent",
                  borderColor:
                    txFilter === f ? "var(--gold)" : "rgba(246,247,248,0.15)",
                  color:
                    txFilter === f
                      ? "var(--near-black)"
                      : "rgba(246,247,248,0.5)",
                  fontWeight: txFilter === f ? 600 : 400,
                }}
              >
                {f === "all"
                  ? "All"
                  : f === "transfers"
                    ? "Transfers"
                    : "Swaps"}
              </button>
            ))}
          </div>
          {loading && (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.875rem 1rem",
                    borderBottom:
                      i < 3 ? "1px solid var(--border-dim)" : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.375rem",
                    }}
                  >
                    <div
                      className="skeleton"
                      style={{ width: "48px", height: "0.875rem" }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: "96px", height: "0.75rem" }}
                    />
                  </div>
                  <div
                    className="skeleton"
                    style={{ width: "72px", height: "0.9375rem" }}
                  />
                </div>
              ))}
            </div>
          )}
          {(() => {
            const filtered = transactions.filter((tx) =>
              txFilter === "all"
                ? true
                : txFilter === "swaps"
                  ? tx.type === "swapped"
                  : tx.type !== "swapped",
            );
            if (!loading && filtered.length === 0)
              return (
                <div
                  className="card"
                  style={{ textAlign: "center", padding: "2rem" }}
                >
                  <p
                    style={{
                      fontSize: "0.875rem",
                      color: "rgba(246,247,248,0.4)",
                    }}
                  >
                    {transactions.length === 0
                      ? "No transactions yet."
                      : `No ${txFilter} found.`}
                  </p>
                </div>
              );
            if (filtered.length === 0) return null;
            return (
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                {filtered.map((tx, i) => (
                  <button
                    key={tx.id}
                    onClick={() => setSelectedTx(tx)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      width: "100%",
                      padding: "0.875rem 1rem",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      borderBottom:
                        i < filtered.length - 1
                          ? "1px solid var(--border-dim)"
                          : "none",
                      color: "var(--off-white)",
                      textAlign: "left",
                      transition: "background 100ms",
                    }}
                  >
                    <div>
                      <p style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                        {tx.type === "sent"
                          ? "↑ Sent"
                          : tx.type === "swapped"
                            ? "⇄ Swap"
                            : "↓ Received"}
                      </p>
                      <p
                        style={{
                          fontSize: "0.75rem",
                          color: "rgba(246,247,248,0.4)",
                          marginTop: "0.125rem",
                          fontFamily: "Inconsolata, monospace",
                        }}
                      >
                        {tx.counterparty.length > 12
                          ? `${tx.counterparty.slice(0, 6)}…${tx.counterparty.slice(-6)}`
                          : tx.counterparty}
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {tx.type === "swapped" ? (
                        <>
                          <p
                            style={{
                              fontFamily: "Inconsolata, monospace",
                              fontSize: "0.875rem",
                            }}
                          >
                            -{tx.amount} {tx.asset}
                          </p>
                          <p
                            style={{
                              fontFamily: "Inconsolata, monospace",
                              fontSize: "0.875rem",
                              color: "var(--teal)",
                              marginTop: "0.125rem",
                            }}
                          >
                            +{tx.destAmount} {tx.destAsset}
                          </p>
                        </>
                      ) : (
                        <p
                          style={{
                            fontFamily: "Inconsolata, monospace",
                            fontSize: "0.9375rem",
                          }}
                        >
                          {tx.amount} {tx.asset}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}{" "}
          {hasMoreWraithTransfers && !loading && (
            <div
              style={{
                marginTop: "1rem",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="btn-ghost"
                style={{
                  minWidth: 160,
                  padding: "0.85rem 1rem",
                  fontSize: "0.875rem",
                }}
              >
                {isLoadingMore ? (
                  <>
                    <div
                      className="spinner"
                      style={{ width: "14px", height: "14px" }}
                    />
                    <span style={{ marginLeft: "0.5rem" }}>Loading…</span>
                  </>
                ) : (
                  "Load more"
                )}
              </button>
            </div>
          )}{" "}
        </section>
      </main>

      {selectedTx && (
        <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />
      )}
    </div>
  );
}

const TOKEN_LOGOS: Record<string, string> = {
  XLM: "/tokens/xlm.png",
  USDC: "/tokens/usdc.png",
};

function TokenIcon({ code, size = 32 }: { code: string; size?: number }) {
  const src = TOKEN_LOGOS[code.toUpperCase()];
  if (src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          flexShrink: 0,
          background: code === "XLM" ? "#000" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Image
          src={src}
          alt={code}
          width={size}
          height={size}
          style={{
            objectFit: "contain",
            ...(code === "XLM" ? { filter: "invert(1)", padding: "4px" } : {}),
          }}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "rgba(253,218,36,0.12)",
        border: "1px solid rgba(253,218,36,0.2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 700,
        color: "var(--gold)",
        flexShrink: 0,
      }}
    >
      {code[0]}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  icon,
  badge,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.625rem",
        padding: "1.25rem 0.5rem",
        cursor: "pointer",
        background: "var(--surface)",
        transition: "all 0.2s ease",
        position: "relative",
      }}
    >
      {badge && (
        <span
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: "var(--gold)",
            border: "2px solid var(--near-black)",
            animation: "badgePulse 2s ease-in-out infinite",
          }}
        />
      )}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        style={{ color: "var(--gold)" }}
      >
        {icon}
      </svg>
      <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>{label}</span>
    </button>
  );
}
