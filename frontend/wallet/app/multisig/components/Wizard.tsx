"use client";
import React, { useState, useEffect } from "react";
import { deployAndInitMultisig } from "@/lib/multisig";

interface WizardProps {
  onDeploySuccess: (contractId: string) => void;
}

export default function Wizard({ onDeploySuccess }: WizardProps) {
  const [owners, setOwners] = useState<string[]>([""]);
  const [threshold, setThreshold] = useState<number>(2);
  const [feePayerSecret, setFeePayerSecret] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the first owner with the active wallet address if logged in
  useEffect(() => {
    const activeAddress = sessionStorage.getItem("invisible_wallet_address");
    if (activeAddress) {
      setOwners([activeAddress, "", ""]);
    } else {
      setOwners(["", "", ""]);
    }
  }, []);

  const updateOwner = (idx: number, value: string) => {
    const next = [...owners];
    next[idx] = value;
    setOwners(next);
  };

  const addOwner = () => setOwners([...owners, ""]);
  const removeOwner = (idx: number) => {
    if (owners.length > 1) {
      const next = owners.filter((_, i) => i !== idx);
      setOwners(next);
    }
  };

  const handleDeploy = async () => {
    setError(null);
    setLoading(true);

    try {
      // Validate inputs
      const filteredOwners = owners.map(o => o.trim()).filter(o => o !== "");
      if (filteredOwners.length < 2) {
        throw new Error("You must add at least 2 signers.");
      }
      for (const owner of filteredOwners) {
        if (!owner.startsWith("G") && !owner.startsWith("C")) {
          throw new Error(`Invalid address format: "${owner}". Address must be G... or C...`);
        }
      }
      if (threshold > filteredOwners.length) {
        throw new Error(`Threshold M (${threshold}) cannot exceed number of active signers (${filteredOwners.length}).`);
      }
      if (threshold < 1) {
        throw new Error("Threshold must be at least 1.");
      }

      const deployedId = await deployAndInitMultisig({
        owners: filteredOwners,
        threshold,
        feePayerSecret: feePayerSecret.trim() || undefined,
      });

      onDeploySuccess(deployedId);
    } catch (err: any) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ padding: "1.5rem", border: "1px solid var(--border-dim)" }}>
      <h3 style={{ fontFamily: "Lora, serif", fontStyle: "italic", fontWeight: 600, fontSize: "1.25rem", marginBottom: "1rem" }}>
        Step 1: Configure M-of-N Signers
      </h3>
      
      <p style={{ fontSize: "0.8125rem", color: "rgba(246,247,248,0.5)", marginBottom: "1rem", lineHeight: 1.5 }}>
        Specify the Stellar addresses (either contract wallets `C...` or public key addresses `G...`) that can collectively authorize transactions.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.25rem" }}>
        {owners.map((o, i) => (
          <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              className="input-field"
              value={o}
              onChange={(e) => updateOwner(i, e.target.value)}
              placeholder={`Signer ${i + 1} address (G... or C...)`}
              style={{
                flex: 1,
                padding: "0.625rem 0.875rem",
                borderRadius: "8px",
                border: "1px solid var(--border-dim)",
                background: "var(--surface)",
                color: "var(--off-white)",
                fontSize: "0.875rem",
                fontFamily: "Inconsolata, monospace"
              }}
            />
            {owners.length > 2 && (
              <button
                onClick={() => removeOwner(i)}
                style={{
                  background: "rgba(255, 100, 100, 0.1)",
                  border: "none",
                  color: "rgb(255, 100, 100)",
                  cursor: "pointer",
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.125rem"
                }}
                title="Remove signer"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginBottom: "1.5rem" }}>
        <button
          onClick={addOwner}
          style={{
            background: "transparent",
            border: "1px dashed rgba(246,247,248,0.2)",
            color: "var(--gold)",
            padding: "0.5rem 1rem",
            borderRadius: "100px",
            fontSize: "0.8125rem",
            cursor: "pointer",
            fontWeight: 500,
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem"
          }}
        >
          <span>+ Add Signer</span>
        </button>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "120px" }}>
          <label style={{ display: "block", fontSize: "0.75rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", marginBottom: "0.375rem" }}>
            Threshold (M)
          </label>
          <input
            type="number"
            className="input-field"
            value={threshold}
            min={1}
            max={owners.filter(o => o !== "").length || 1}
            onChange={(e) => setThreshold(parseInt(e.target.value || "1"))}
            style={{
              width: "100%",
              padding: "0.625rem 0.875rem",
              borderRadius: "8px",
              border: "1px solid var(--border-dim)",
              background: "var(--surface)",
              color: "var(--off-white)",
              fontSize: "0.875rem"
            }}
          />
        </div>

        <div style={{ flex: 2, minWidth: "220px" }}>
          <label style={{ display: "block", fontSize: "0.75rem", color: "rgba(246,247,248,0.4)", textTransform: "uppercase", marginBottom: "0.375rem" }}>
            Optional Custom Gas Secret (S...)
          </label>
          <input
            type="password"
            className="input-field"
            value={feePayerSecret}
            onChange={(e) => setFeePayerSecret(e.target.value)}
            placeholder="Leaves empty to auto-fund via Friendbot"
            style={{
              width: "100%",
              padding: "0.625rem 0.875rem",
              borderRadius: "8px",
              border: "1px solid var(--border-dim)",
              background: "var(--surface)",
              color: "var(--off-white)",
              fontSize: "0.875rem",
              fontFamily: "Inconsolata, monospace"
            }}
          />
        </div>
      </div>

      {error && (
        <div style={{
          padding: "0.75rem 1rem",
          background: "rgba(255,100,100,0.08)",
          border: "1px solid rgba(255,100,100,0.2)",
          borderRadius: "8px",
          color: "rgb(255,120,120)",
          fontSize: "0.8125rem",
          marginBottom: "1rem"
        }}>
          {error}
        </div>
      )}

      <div>
        <button
          className="btn-gold"
          onClick={handleDeploy}
          disabled={loading}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <div className="spinner" style={{ width: "16px", height: "16px", border: "2px solid var(--near-black)", borderTopColor: "transparent" }} />
              <span>Deploying Contract (takes ~15s)...</span>
            </div>
          ) : (
            <span>Deploy Multisig Wallet Contract</span>
          )}
        </button>
      </div>
    </div>
  );
}
