"use client";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Wizard from "./components/Wizard";
import PendingQueue from "./components/PendingQueue";
import { VeilLogo } from "@/components/VeilLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function MultisigPage() {
  const router = useRouter();
  const [contractAddress, setContractAddress] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("veil_multisig_contract");
      if (stored) {
        setContractAddress(stored);
      }
    }
  }, []);

  const handleDeploySuccess = (address: string) => {
    localStorage.setItem("veil_multisig_contract", address);
    setContractAddress(address);
  };

  const handleReset = () => {
    if (confirm("Are you sure you want to configure/deploy another multisig wallet?")) {
      localStorage.removeItem("veil_multisig_contract");
      setContractAddress(null);
    }
  };

  return (
    <div className="wallet-shell">
      {/* Navigation */}
      <nav className="wallet-nav" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem" }}>
        <button
          onClick={() => router.push("/dashboard")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--off-white)",
            display: "flex",
            alignItems: "center",
            gap: "0.375rem",
            fontSize: "0.875rem"
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Dashboard
        </button>
        <VeilLogo size={22} />
        <ThemeToggle />
      </nav>

      {/* Main Content */}
      <main className="wallet-main" style={{ paddingTop: "3rem", paddingBottom: "3rem" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h1 style={{
            fontFamily: "Lora, Georgia, serif",
            fontWeight: 600,
            fontStyle: "italic",
            fontSize: "1.75rem",
            color: "var(--off-white)",
            marginBottom: "0.25rem"
          }}>
            DAO Multisig Hub
          </h1>
          <p style={{ fontSize: "0.875rem", color: "rgba(246,247,248,0.5)", lineHeight: 1.5 }}>
            Create M-of-N multisig wallets programmatically, propose native XLM token transfers, and collect signatures completely on-chain.
          </p>
        </div>

        {contractAddress ? (
          <PendingQueue contractId={contractAddress} onReset={handleReset} />
        ) : (
          <Wizard onDeploySuccess={handleDeploySuccess} />
        )}
      </main>
    </div>
  );
}
