"use client";
import React, { useState, useEffect, useCallback } from "react";
import {
  getProposalsOnChain,
  proposeTransaction,
  signTransaction,
  fetchMultisigDetails,
  type ProposalDetails,
  type MultisigDetails
} from "@/lib/multisig";

interface PendingQueueProps {
  contractId: string;
  onReset: () => void;
}

export default function PendingQueue({ contractId, onReset }: PendingQueueProps) {
  const [details, setDetails] = useState<MultisigDetails | null>(null);
  const [proposals, setProposals] = useState<ProposalDetails[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // New proposal form
  const [toAddress, setToAddress] = useState("");
  const [amountXlm, setAmountXlm] = useState("");
  const [proposeLoading, setProposeLoading] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);

  // Signing form
  const [signingSecrets, setSigningSecrets] = useState<Record<number, string>>({});
  const [signLoading, setSignLoading] = useState<Record<number, boolean>>({});
  const [signError, setSignError] = useState<Record<number, string | null>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchMultisigDetails(contractId);
      setDetails(d);
      const p = await getProposalsOnChain(contractId);
      setProposals(p);
    } catch (err: any) {
      console.error(err);
      setError("Failed to fetch multisig info from chain. Make sure it was deployed successfully.");
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePropose = async (e: React.FormEvent) => {
    e.preventDefault();
    setProposeError(null);
    setProposeLoading(true);

    try {
      if (!toAddress || !amountXlm) {
        throw new Error("Please specify both destination address and XLM amount.");
      }
      if (parseFloat(amountXlm) <= 0) {
        throw new Error("Amount must be greater than zero.");
      }

      await proposeTransaction({
        contractId,
        to: toAddress.trim(),
        amountXlm: amountXlm.trim(),
      });

      setToAddress("");
      setAmountXlm("");
      await loadData();
    } catch (err: any) {
      console.error(err);
      setProposeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProposeLoading(false);
    }
  };

  const handleSign = async (proposalId: number) => {
    setSignError(prev => ({ ...prev, [proposalId]: null }));
    setSignLoading(prev => ({ ...prev, [proposalId]: true }));

    try {
      const secret = signingSecrets[proposalId]?.trim();
      if (!secret) {
        throw new Error("Please enter your owner secret key (S...) to sign.");
      }

      await signTransaction({
        contractId,
        proposalId,
        signerSecret: secret,
      });

      // Clear the secret
      setSigningSecrets(prev => ({ ...prev, [proposalId]: "" }));
      await loadData();
    } catch (err: any) {
      console.error(err);
      setSignError(prev => ({ ...prev, [proposalId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSignLoading(prev => ({ ...prev, [proposalId]: false }));
    }
  };

  const prefillActiveSigner = (proposalId: number) => {
    const activeSecret = sessionStorage.getItem("veil_signer_secret") || localStorage.getItem("veil_signer_secret") || "";
    if (activeSecret) {
      setSigningSecrets(prev => ({ ...prev, [proposalId]: activeSecret }));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      
      {/* 1. Header & Configuration Details */}
      {details && (
        <div className="card" style={{ padding: "1.5rem", border: "1px solid var(--border-dim)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
            <div>
              <h2 style={{ fontFamily: "Lora, serif", fontWeight: 600, fontStyle: "italic", fontSize: "1.5rem", color: "var(--off-white)" }}>
                Active Multisig Wallet
              </h2>
              <p style={{ fontFamily: "Inconsolata, monospace", fontSize: "0.8125rem", color: "var(--gold)", wordBreak: "break-all", marginTop: "0.25rem" }}>
                {contractId}
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                className="btn-gold"
                onClick={loadData}
                disabled={loading}
                style={{ fontSize: "0.75rem", padding: "0.5rem 1rem" }}
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={onReset}
                style={{
                  background: "rgba(255, 100, 100, 0.1)",
                  border: "1px solid rgba(255, 100, 100, 0.2)",
                  color: "rgb(255, 120, 120)",
                  fontSize: "0.75rem",
                  padding: "0.5rem 1rem",
                  borderRadius: "100px",
                  cursor: "pointer"
                }}
              >
                Deploy New
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", background: "rgba(255,255,255,0.02)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--border-dim)" }}>
            <div>
              <span style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", display: "block" }}>Contract Balance</span>
              <span style={{ fontFamily: "Inconsolata, monospace", fontSize: "1.125rem", fontWeight: 600, color: "var(--teal)" }}>{details.balanceXlm} XLM</span>
            </div>
            <div>
              <span style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", display: "block" }}>Threshold</span>
              <span style={{ fontSize: "1.125rem", fontWeight: 600, color: "var(--off-white)" }}>{details.threshold} of {details.owners.length}</span>
            </div>
          </div>

          <div style={{ marginTop: "1rem" }}>
            <span style={{ fontSize: "0.75rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", display: "block", marginBottom: "0.375rem" }}>Registered Owners</span>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              {details.owners.map((owner, i) => (
                <div key={i} style={{ fontFamily: "Inconsolata, monospace", fontSize: "0.75rem", color: "rgba(246,247,248,0.7)", background: "rgba(255,255,255,0.01)", padding: "4px 8px", borderRadius: "4px" }}>
                  #{i + 1}: {owner}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: "1rem", border: "1px solid rgba(255,100,100,0.2)", background: "rgba(255,100,100,0.05)", color: "rgb(255,120,120)", fontSize: "0.875rem" }}>
          {error}
        </div>
      )}

       <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "1.5rem" }} className="grid-cols-1 md:grid-cols-2">
        
        {/* 2. Propose New Transaction Form */}
        <div className="card" style={{ padding: "1.5rem", border: "1px solid var(--border-dim)" }}>
          <h3 style={{ fontFamily: "Lora, serif", fontStyle: "italic", fontWeight: 600, fontSize: "1.25rem", marginBottom: "1rem" }}>
            Propose XLM Transfer
          </h3>
          <form onSubmit={handlePropose} style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", marginBottom: "0.25rem" }}>
                To (Stellar Address)
              </label>
              <input
                className="input-field"
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                placeholder="G... or C..."
                style={{ width: "100%", padding: "0.625rem 0.875rem", borderRadius: "8px", border: "1px solid var(--border-dim)", background: "var(--surface)", color: "var(--off-white)", fontFamily: "Inconsolata, monospace" }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "0.75rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", marginBottom: "0.25rem" }}>
                Amount (XLM)
              </label>
              <input
                type="number"
                step="any"
                className="input-field"
                value={amountXlm}
                onChange={(e) => setAmountXlm(e.target.value)}
                placeholder="0.0"
                style={{ width: "100%", padding: "0.625rem 0.875rem", borderRadius: "8px", border: "1px solid var(--border-dim)", background: "var(--surface)", color: "var(--off-white)" }}
              />
            </div>

            {proposeError && (
              <p style={{ color: "rgb(255,120,120)", fontSize: "0.75rem" }}>{proposeError}</p>
            )}

            <button
              type="submit"
              className="btn-gold"
              disabled={proposeLoading}
              style={{ justifyContent: "center", marginTop: "0.5rem" }}
            >
              {proposeLoading ? "Submitting Proposal..." : "Submit Proposal"}
            </button>
          </form>
        </div>

        {/* 3. Pending Proposals Queue */}
        <div>
          <h3 style={{ fontFamily: "Lora, serif", fontStyle: "italic", fontWeight: 600, fontSize: "1.25rem", marginBottom: "1rem" }}>
            Proposals Queue
          </h3>

          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <div className="spinner" style={{ display: "inline-block", width: "24px", height: "24px" }} />
              <p style={{ fontSize: "0.875rem", color: "rgba(246,247,248,0.4)", marginTop: "0.5rem" }}>Fetching proposals...</p>
            </div>
          ) : proposals.length === 0 ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center", border: "1px solid var(--border-dim)" }}>
              <p style={{ fontSize: "0.875rem", color: "rgba(246,247,248,0.4)" }}>No proposed transactions yet.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {proposals.map((tx) => {
                const threshold = details?.threshold ?? 2;
                const isApproved = tx.approvals.length >= threshold;
                return (
                  <div
                    key={tx.id}
                    className="card"
                    style={{
                      padding: "1.25rem",
                      border: "1px solid var(--border-dim)",
                      background: tx.executed
                        ? "rgba(0, 167, 181, 0.03)"
                        : "var(--surface)",
                      borderColor: tx.executed
                        ? "rgba(0, 167, 181, 0.2)"
                        : "var(--border-dim)"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.75rem", alignItems: "center" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 600, padding: "2px 8px", borderRadius: "100px", background: "rgba(246,247,248,0.08)", color: "rgba(246,247,248,0.7)" }}>
                        Proposal #{tx.id}
                      </span>
                      <span style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        color: tx.executed ? "var(--teal)" : isApproved ? "var(--gold)" : "rgba(246,247,248,0.4)"
                      }}>
                        {tx.executed ? "Executed" : isApproved ? "Awaiting Execution" : "Pending Signatures"}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", marginBottom: "1rem" }}>
                      <div>
                        <span style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase" }}>Destination</span>
                        <p style={{ fontFamily: "Inconsolata, monospace", fontSize: "0.8125rem", wordBreak: "break-all" }}>{tx.to}</p>
                      </div>
                      <div>
                        <span style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase" }}>Amount</span>
                        <p style={{ fontSize: "1rem", fontWeight: 600 }}>{tx.amount} XLM</p>
                      </div>
                      <div>
                        <span style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase" }}>Approvals ({tx.approvals.length}/{threshold})</span>
                        {tx.approvals.length > 0 ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "4px" }}>
                            {tx.approvals.map((app, idx) => (
                              <div key={idx} style={{ fontSize: "0.6875rem", color: "rgba(246,247,248,0.5)", fontFamily: "Inconsolata, monospace", wordBreak: "break-all" }}>
                                ✓ {app}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p style={{ fontSize: "0.75rem", color: "rgba(246,247,248,0.3)" }}>None yet</p>
                        )}
                      </div>
                    </div>

                    {/* Sign Action (if not executed) */}
                    {!tx.executed && (
                      <div style={{ borderTop: "1px dashed var(--border-dim)", paddingTop: "1rem", marginTop: "0.5rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                          <input
                            type="password"
                            className="input-field"
                            placeholder="Your Owner Secret Key (S...)"
                            value={signingSecrets[tx.id] || ""}
                            onChange={(e) => setSigningSecrets(prev => ({ ...prev, [tx.id]: e.target.value }))}
                            style={{
                              flex: 1,
                              padding: "0.5rem 0.75rem",
                              borderRadius: "6px",
                              border: "1px solid var(--border-dim)",
                              background: "rgba(0,0,0,0.1)",
                              fontSize: "0.8125rem",
                              fontFamily: "Inconsolata, monospace"
                            }}
                          />
                          <button
                            onClick={() => prefillActiveSigner(tx.id)}
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--gold)",
                              fontSize: "0.75rem",
                              cursor: "pointer",
                              textDecoration: "underline",
                              padding: "0 0.25rem"
                            }}
                            title="Use Active Device Private Key"
                          >
                            Use Active
                          </button>
                        </div>

                        {signError[tx.id] && (
                          <p style={{ color: "rgb(255,120,120)", fontSize: "0.75rem", marginBottom: "0.5rem" }}>{signError[tx.id]}</p>
                        )}

                        <button
                          className="btn-gold"
                          onClick={() => handleSign(tx.id)}
                          disabled={signLoading[tx.id]}
                          style={{
                            width: "100%",
                            padding: "0.5rem 1rem",
                            fontSize: "0.8125rem",
                            justifyContent: "center"
                          }}
                        >
                          {signLoading[tx.id] ? "Approving..." : "Approve & Sign Transaction"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
