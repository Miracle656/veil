import { ref as _, onMounted as q, onUnmounted as Q, readonly as U } from "vue";
import { hash as $, StrKey as L, xdr as p, Horizon as Y, Keypair as N, rpc as d, Networks as Z, Contract as v, TransactionBuilder as C, BASE_FEE as T, nativeToScVal as y, Account as z, scValToNative as D } from "@stellar/stellar-sdk";
function B(h) {
  const e = h instanceof Uint8Array ? h : new Uint8Array(h);
  return Array.from(e).map((t) => t.toString(16).padStart(2, "0")).join("");
}
function H(h) {
  if (h.length % 2 !== 0) throw new Error("Invalid hex string");
  const e = new Uint8Array(h.length / 2);
  for (let t = 0; t < h.length; t += 2)
    e[t / 2] = parseInt(h.substring(t, t + 2), 16);
  return e;
}
const W = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, ee = W >> 1n;
function te(h) {
  let e = 0n;
  for (const r of h) e = e << 8n | BigInt(r);
  e > ee && (e = W - e);
  const t = new Uint8Array(32);
  for (let r = 31; r >= 0; r--)
    t[r] = Number(e & 0xffn), e >>= 8n;
  return t;
}
function re(h) {
  const e = new Uint8Array(h);
  if (e[0] !== 48) throw new Error("DER: expected SEQUENCE (0x30)");
  let t = 2;
  if (e[t] !== 2) throw new Error("DER: expected INTEGER tag for r");
  t++;
  const r = e[t++], n = e.slice(t, t + r);
  if (t += r, e[t] !== 2) throw new Error("DER: expected INTEGER tag for s");
  t++;
  const s = e[t++], i = e.slice(t, t + s), o = new Uint8Array(64);
  return o.set(G(n), 0), o.set(te(G(i)), 32), o;
}
function G(h) {
  let e = 0;
  for (; e < h.length - 32 && h[e] === 0; ) e++;
  const t = h.slice(e);
  if (t.length > 32) throw new Error("Integer component too large for P-256");
  const r = new Uint8Array(32);
  return r.set(t, 32 - t.length), r;
}
async function se(h) {
  const e = h.getPublicKey();
  if (!e)
    throw new Error(
      "getPublicKey() returned null — authenticator may not support SPKI export, or the browser is too old (requires Chrome 95+ / Firefox 93+)"
    );
  const t = await crypto.subtle.importKey(
    "spki",
    e,
    { name: "ECDSA", namedCurve: "P-256" },
    !0,
    // extractable
    ["verify"]
  ), r = await crypto.subtle.exportKey("raw", t);
  return new Uint8Array(r);
}
function X(h, e, t = "Test SDF Network ; September 2015") {
  const r = $(Buffer.from(e)), n = $(Buffer.from(t)), s = L.decodeContract(h), i = p.HashIdPreimage.envelopeTypeContractId(
    new p.HashIdPreimageContractId({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      networkId: n,
      contractIdPreimage: p.ContractIdPreimage.contractIdPreimageFromAddress(
        new p.ContractIdPreimageFromAddress({
          address: p.ScAddress.scAddressTypeContract(s),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          salt: r
        })
      )
    })
  ), o = $(i.toXDR());
  return L.encodeContract(o);
}
const ne = Y.Server;
class j extends Error {
  constructor(e) {
    super(`Recovery timelock active until ${e}`), this.unlockTime = e, this.name = "RecoveryTimelockActive";
  }
}
class K extends Error {
  constructor() {
    super("No guardian set on this wallet"), this.name = "NoGuardianSet";
  }
}
class F extends Error {
  constructor() {
    super("No recovery is currently pending"), this.name = "RecoveryNotPending";
  }
}
const oe = 1e3, M = 30;
async function x(h, e) {
  for (let t = 0; t < M; t++) {
    const r = await h.getTransaction(e);
    if (r.status !== d.Api.GetTransactionStatus.NOT_FOUND)
      return r;
    await new Promise((n) => setTimeout(n, oe));
  }
  throw new Error(`Transaction ${e} not confirmed after ${M} attempts`);
}
class ie {
  constructor(e, t) {
    this.address = null, this.isDeployed = !1, this.pendingCount = 0, this.errorValue = null, this.config = e, this.onStateChange = t;
    const r = localStorage.getItem("invisible_wallet_address");
    r && (this.address = r, this.notifyStateChange());
  }
  setPending(e) {
    e ? this.pendingCount++ : this.pendingCount--, this.notifyStateChange();
  }
  setError(e) {
    this.errorValue = e, this.notifyStateChange();
  }
  setAddress(e) {
    this.address = e, this.notifyStateChange();
  }
  setIsDeployed(e) {
    this.isDeployed = e, this.notifyStateChange();
  }
  notifyStateChange() {
    this.onStateChange && this.onStateChange({
      address: this.address,
      isDeployed: this.isDeployed,
      isPending: this.pendingCount > 0,
      error: this.errorValue
    });
  }
  getAddress() {
    return this.address;
  }
  getIsDeployed() {
    return this.isDeployed;
  }
  async register(e) {
    this.setPending(!0), this.setError(null);
    try {
      const t = crypto.getRandomValues(new Uint8Array(32)), r = e || "Veil User", n = e ? new TextEncoder().encode(e) : crypto.getRandomValues(new Uint8Array(16)), s = await navigator.credentials.create({
        publicKey: {
          challenge: t,
          rp: { name: "Invisible Wallet" },
          user: {
            id: n,
            name: r,
            displayName: r
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 6e4,
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required"
          }
        }
      });
      if (!s) throw new Error("Credential creation failed");
      const i = s.response, o = await se(i), a = B(o), l = X(
        this.config.factoryAddress,
        o,
        this.config.networkPassphrase
      );
      return localStorage.setItem("invisible_wallet_address", l), localStorage.setItem("invisible_wallet_key_id", s.id), localStorage.setItem("invisible_wallet_public_key", a), this.setAddress(l), this.setIsDeployed(!1), { walletAddress: l, publicKeyBytes: o };
    } catch (t) {
      const r = t instanceof Error ? t.message : String(t);
      throw this.setError(r), t;
    } finally {
      this.setPending(!1);
    }
  }
  async deploy(e, t) {
    var s;
    const r = typeof e == "string" ? N.fromSecret(e) : N.fromSecret(e.secret());
    this.setPending(!0), this.setError(null);
    let n;
    try {
      let i = t;
      if (!i) {
        const k = localStorage.getItem("invisible_wallet_public_key");
        if (!k) throw new Error("No public key found. Call register() first, or pass publicKeyBytes explicitly.");
        i = H(k);
      }
      n = X(
        this.config.factoryAddress,
        i,
        this.config.networkPassphrase
      );
      const o = new d.Server(this.config.rpcUrl), a = this.config.networkPassphrase === Z.TESTNET ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org", u = await new ne(a).loadAccount(r.publicKey()), c = new v(this.config.factoryAddress), f = new TextEncoder().encode(this.config.rpId ?? window.location.hostname), m = new TextEncoder().encode(this.config.origin ?? window.location.origin), A = new C(u, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(
        c.call(
          "deploy",
          y(i, { type: "bytes" }),
          y(f, { type: "bytes" }),
          y(m, { type: "bytes" })
        )
      ).setTimeout(30).build(), R = await o.simulateTransaction(A);
      if (d.Api.isSimulationError(R))
        throw new Error(`Simulation failed: ${R.error}`);
      const b = d.assembleTransaction(A, R).build();
      b.sign(r);
      const S = await o.sendTransaction(b);
      if (S.status === "ERROR")
        throw new Error(`Transaction rejected: ${((s = S.errorResult) == null ? void 0 : s.toXDR("base64")) ?? "unknown error"}`);
      const E = await x(o, S.hash);
      if (E.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${E.status}`);
      return this.setAddress(n), this.setIsDeployed(!0), localStorage.setItem("invisible_wallet_address", n), { walletAddress: n, alreadyDeployed: !1 };
    } catch (i) {
      let o;
      if (i instanceof Error)
        o = i.message;
      else
        try {
          o = JSON.stringify(i);
        } catch {
          o = String(i);
        }
      if (o.toLowerCase().includes("alreadydeployed") || o.toLowerCase().includes("already_deployed"))
        return this.setAddress(n), this.setIsDeployed(!0), localStorage.setItem("invisible_wallet_address", n), { walletAddress: n, alreadyDeployed: !0 };
      throw this.setError(o), new Error(o);
    } finally {
      this.setPending(!1);
    }
  }
  async login() {
    this.setPending(!0), this.setError(null);
    try {
      const e = localStorage.getItem("invisible_wallet_address");
      if (!e)
        return this.setError("No wallet found. Please register first."), null;
      const t = new d.Server(this.config.rpcUrl);
      try {
        return await t.getContractData(
          e,
          p.ScVal.scvLedgerKeyContractInstance(),
          d.Durability.Persistent
        ), this.setAddress(e), this.setIsDeployed(!0), { walletAddress: e };
      } catch (r) {
        if ((r instanceof Error ? r.message : String(r)).toLowerCase().includes("not found"))
          return this.setError("Wallet not yet deployed. Call deploy() to create it on-chain."), this.setAddress(null), this.setIsDeployed(!1), null;
        throw r;
      }
    } catch (e) {
      return this.setError(e instanceof Error ? e.message : String(e)), null;
    } finally {
      this.setPending(!1);
    }
  }
  async signAuthEntry(e) {
    this.setPending(!0), this.setError(null);
    try {
      const t = localStorage.getItem("invisible_wallet_key_id"), r = localStorage.getItem("invisible_wallet_public_key");
      if (!t) throw new Error("No key ID found. Please register first.");
      if (!r) throw new Error("No public key found. Please register first.");
      if (e.length !== 32)
        throw new Error("signaturePayload must be exactly 32 bytes");
      const n = e.buffer.slice(
        e.byteOffset,
        e.byteOffset + e.byteLength
      ), s = atob(t.replace(/-/g, "+").replace(/_/g, "/")), i = Uint8Array.from(s, (c) => c.charCodeAt(0)), o = await navigator.credentials.get({
        publicKey: {
          challenge: n,
          allowCredentials: [{ id: i, type: "public-key" }],
          userVerification: "required"
        }
      });
      if (!o) throw new Error("Signing was cancelled");
      const a = o.response, l = re(a.signature);
      return {
        publicKey: H(r),
        authData: new Uint8Array(a.authenticatorData),
        clientDataJSON: new Uint8Array(a.clientDataJSON),
        signature: l
      };
    } catch (t) {
      throw this.setError(t instanceof Error ? t.message : String(t)), t;
    } finally {
      this.setPending(!1);
    }
  }
  async getNonce() {
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const e = new d.Server(this.config.rpcUrl), t = new v(this.address), r = N.random(), n = new z(r.publicKey(), "0"), s = new C(n, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(t.call("get_nonce")).setTimeout(30).build(), i = await e.simulateTransaction(s);
      if (d.Api.isSimulationError(i))
        throw new Error(`Simulation failed: ${i.error}`);
      const o = i.result;
      if (!o) throw new Error("Simulation returned no result");
      return D(o.retval);
    } catch (e) {
      const t = e instanceof Error ? e.message : String(e);
      throw this.setError(t), e;
    } finally {
      this.setPending(!1);
    }
  }
  async addSigner(e, t) {
    var r;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      if (t.length !== 65)
        throw new Error("newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)");
      const n = new d.Server(this.config.rpcUrl), s = new v(this.address), i = await n.getAccount(e.publicKey()), o = new C(i, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(s.call("add_signer", y(t, { type: "bytes" }))).setTimeout(30).build(), a = await n.simulateTransaction(o);
      if (d.Api.isSimulationError(a))
        throw new Error(`Simulation failed: ${a.error}`);
      const l = d.assembleTransaction(o, a).build();
      l.sign(e);
      const u = await n.sendTransaction(l);
      if (u.status === "ERROR")
        throw new Error(`Transaction rejected: ${((r = u.errorResult) == null ? void 0 : r.toXDR("base64")) ?? "unknown error"}`);
      const c = await x(n, u.hash);
      if (c.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${c.status}`);
      let f = 0;
      if ("returnValue" in c && c.returnValue)
        try {
          f = D(c.returnValue);
        } catch {
        }
      return { signerIndex: f };
    } catch (n) {
      const s = n instanceof Error ? n.message : String(n);
      throw this.setError(s), n;
    } finally {
      this.setPending(!1);
    }
  }
  async getSigners() {
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const e = new d.Server(this.config.rpcUrl), t = new v(this.address), r = N.random(), n = new z(r.publicKey(), "0"), s = new C(n, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(t.call("get_signers")).setTimeout(30).build(), i = await e.simulateTransaction(s);
      if (d.Api.isSimulationError(i))
        throw new Error(`Simulation failed: ${i.error}`);
      const o = i.result;
      if (!o) throw new Error("Simulation returned no result");
      const a = D(o.retval), l = [], u = a instanceof Map ? a.entries() : Object.entries(a);
      for (const [c, f] of u)
        l.push({
          index: typeof c == "string" ? parseInt(c, 10) : c,
          publicKey: B(f)
        });
      return l.sort((c, f) => c.index - f.index);
    } catch (e) {
      const t = e instanceof Error ? e.message : String(e);
      throw this.setError(t), e;
    } finally {
      this.setPending(!1);
    }
  }
  async removeSigner(e, t) {
    var r;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const n = new d.Server(this.config.rpcUrl), s = new v(this.address), i = await n.getAccount(e.publicKey()), o = new C(i, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(s.call("remove_signer", y(t, { type: "u32" }))).setTimeout(30).build(), a = await n.simulateTransaction(o);
      if (d.Api.isSimulationError(a))
        throw new Error(`Simulation failed: ${a.error}`);
      const l = d.assembleTransaction(o, a).build();
      l.sign(e);
      const u = await n.sendTransaction(l);
      if (u.status === "ERROR")
        throw new Error(`Transaction rejected: ${((r = u.errorResult) == null ? void 0 : r.toXDR("base64")) ?? "unknown error"}`);
      const c = await x(n, u.hash);
      if (c.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${c.status}`);
    } catch (n) {
      const s = n instanceof Error ? n.message : String(n);
      throw this.setError(s), n;
    } finally {
      this.setPending(!1);
    }
  }
  async setGuardian(e, t) {
    var r, n;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const s = new d.Server(this.config.rpcUrl), i = new v(this.address), o = await s.getAccount(e.publicKey()), a = new C(o, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(i.call("set_guardian", y(t, { type: "address" }))).setTimeout(30).build(), l = await s.simulateTransaction(a);
      if (d.Api.isSimulationError(l))
        throw new Error(`Simulation failed: ${l.error}`);
      const u = d.assembleTransaction(a, l).build(), f = (r = l.result) == null ? void 0 : r.auth;
      if (f) {
        const R = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.config.networkPassphrase))
        );
        for (const b of f) {
          const S = b.credentials();
          if (S.switch().value !== p.SorobanCredentialsType.sorobanCredentialsAddress().value)
            continue;
          const E = S.address(), k = p.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new p.HashIdPreimageSorobanAuthorization({
              networkId: Buffer.from(R),
              nonce: E.nonce(),
              invocation: b.rootInvocation(),
              signatureExpirationLedger: E.signatureExpirationLedger()
            })
          ), w = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(k.toXDR()))
          ), g = await this.signAuthEntry(w);
          if (!g) throw new Error("WebAuthn signing was cancelled");
          const P = p.ScVal.scvVec([
            y(g.publicKey, { type: "bytes" }),
            y(g.authData, { type: "bytes" }),
            y(g.clientDataJSON, { type: "bytes" }),
            y(g.signature, { type: "bytes" })
          ]);
          b.credentials(
            p.SorobanCredentials.sorobanCredentialsAddress(
              new p.SorobanAddressCredentials({
                address: E.address(),
                nonce: E.nonce(),
                signatureExpirationLedger: E.signatureExpirationLedger(),
                signature: P
              })
            )
          );
        }
      }
      u.sign(e);
      const m = await s.sendTransaction(u);
      if (m.status === "ERROR")
        throw new Error(`Transaction rejected: ${((n = m.errorResult) == null ? void 0 : n.toXDR("base64")) ?? "unknown error"}`);
      const A = await x(s, m.hash);
      if (A.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${A.status}`);
    } catch (s) {
      const i = s instanceof Error ? s.message : String(s);
      throw this.setError(i), s;
    } finally {
      this.setPending(!1);
    }
  }
  async initiateRecovery(e, t) {
    var r;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      if (t.length !== 65)
        throw new Error("newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)");
      const n = new d.Server(this.config.rpcUrl), s = new v(this.address), i = await n.getAccount(e.publicKey()), o = new C(i, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(s.call("initiate_recovery", y(t, { type: "bytes" }))).setTimeout(30).build(), a = await n.simulateTransaction(o);
      if (d.Api.isSimulationError(a)) {
        const m = a.error ?? "";
        throw m.includes("NoGuardianSet") || m.includes("no guardian") ? new K() : new Error(`Simulation failed: ${m}`);
      }
      const l = d.assembleTransaction(o, a).build();
      l.sign(e);
      const u = await n.sendTransaction(l);
      if (u.status === "ERROR")
        throw new Error(`Transaction rejected: ${((r = u.errorResult) == null ? void 0 : r.toXDR("base64")) ?? "unknown error"}`);
      const c = await x(n, u.hash);
      if (c.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${c.status}`);
      let f = 0;
      if ("returnValue" in c && c.returnValue)
        try {
          f = Number(D(c.returnValue));
        } catch {
        }
      return { unlockTime: f };
    } catch (n) {
      if (n instanceof K) throw n;
      const s = n instanceof Error ? n.message : String(n);
      throw this.setError(s), n;
    } finally {
      this.setPending(!1);
    }
  }
  async completeRecovery(e) {
    var t;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const r = new d.Server(this.config.rpcUrl), n = new v(this.address), s = await r.getAccount(e.publicKey()), i = new C(s, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(n.call("complete_recovery")).setTimeout(30).build(), o = await r.simulateTransaction(i);
      if (d.Api.isSimulationError(o)) {
        const c = o.error ?? "";
        if (c.includes("TimelockActive") || c.includes("timelock")) {
          const f = c.match(/(\d{10,})/), m = f ? Number(f[1]) : 0;
          throw new j(m);
        }
        throw c.includes("NoGuardianSet") || c.includes("no guardian") ? new K() : c.includes("NotPending") || c.includes("not pending") ? new F() : new Error(`Simulation failed: ${c}`);
      }
      const a = d.assembleTransaction(i, o).build();
      a.sign(e);
      const l = await r.sendTransaction(a);
      if (l.status === "ERROR")
        throw new Error(`Transaction rejected: ${((t = l.errorResult) == null ? void 0 : t.toXDR("base64")) ?? "unknown error"}`);
      const u = await x(r, l.hash);
      if (u.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${u.status}`);
    } catch (r) {
      if (r instanceof j || r instanceof K || r instanceof F)
        throw r;
      const n = r instanceof Error ? r.message : String(r);
      throw this.setError(n), r;
    } finally {
      this.setPending(!1);
    }
  }
  async getAllowance(e, t) {
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const r = new d.Server(this.config.rpcUrl), n = new v(this.address), s = N.random(), i = new z(s.publicKey(), "0"), o = new C(i, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(n.call("get_allowance", y(e, { type: "address" }), y(t, { type: "address" }))).setTimeout(30).build(), a = await r.simulateTransaction(o);
      if (d.Api.isSimulationError(a))
        throw new Error(`Simulation failed: ${a.error}`);
      const l = a.result;
      if (!l || !l.retval) throw new Error("Simulation returned no result");
      if (l.retval.switch() === p.ScValType.scvVoid())
        return null;
      const u = D(l.retval);
      return {
        amount: Number(u.amount),
        expiry: u.expiry !== void 0 ? Number(u.expiry) : void 0
      };
    } catch (r) {
      const n = r instanceof Error ? r.message : String(r);
      throw this.setError(n), r;
    } finally {
      this.setPending(!1);
    }
  }
  async approve(e, t, r, n, s) {
    var i, o;
    this.setPending(!0), this.setError(null);
    try {
      if (!this.address) throw new Error("No wallet address. Call register() or login() first.");
      const a = new d.Server(this.config.rpcUrl), l = new v(this.address), u = await a.getAccount(e.publicKey());
      let c;
      s !== void 0 ? c = y([y(BigInt(s), { type: "u64" })], { type: "Vec" }) : c = p.ScVal.scvVoid();
      const f = new C(u, {
        fee: T,
        networkPassphrase: this.config.networkPassphrase
      }).addOperation(l.call("approve", y(t, { type: "address" }), y(r, { type: "address" }), y(BigInt(n), { type: "i128" }), c)).setTimeout(30).build(), m = await a.simulateTransaction(f);
      if (d.Api.isSimulationError(m))
        throw new Error(`Simulation failed: ${m.error}`);
      const A = d.assembleTransaction(f, m).build(), b = (i = m.result) == null ? void 0 : i.auth;
      if (b) {
        const k = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.config.networkPassphrase))
        );
        for (const w of b) {
          const g = w.credentials();
          if (g.switch().value !== p.SorobanCredentialsType.sorobanCredentialsAddress().value)
            continue;
          const P = g.address(), O = p.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new p.HashIdPreimageSorobanAuthorization({
              networkId: Buffer.from(k),
              nonce: P.nonce(),
              invocation: w.rootInvocation(),
              signatureExpirationLedger: P.signatureExpirationLedger()
            })
          ), V = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(O.toXDR()))
          ), I = await this.signAuthEntry(V);
          if (!I) throw new Error("WebAuthn signing was cancelled");
          const J = p.ScVal.scvVec([
            y(I.publicKey, { type: "bytes" }),
            y(I.authData, { type: "bytes" }),
            y(I.clientDataJSON, { type: "bytes" }),
            y(I.signature, { type: "bytes" })
          ]);
          w.credentials(
            p.SorobanCredentials.sorobanCredentialsAddress(
              new p.SorobanAddressCredentials({
                address: P.address(),
                nonce: P.nonce(),
                signatureExpirationLedger: P.signatureExpirationLedger(),
                signature: J
              })
            )
          );
        }
      }
      A.sign(e);
      const S = await a.sendTransaction(A);
      if (S.status === "ERROR")
        throw new Error(`Transaction rejected: ${((o = S.errorResult) == null ? void 0 : o.toXDR("base64")) ?? "unknown error"}`);
      const E = await x(a, S.hash);
      if (E.status !== d.Api.GetTransactionStatus.SUCCESS)
        throw new Error(`Transaction failed with status: ${E.status}`);
    } catch (a) {
      const l = a instanceof Error ? a.message : String(a);
      throw this.setError(l), a;
    } finally {
      this.setPending(!1);
    }
  }
}
function le(h) {
  const e = _(null), t = _(!1), r = _(!1), n = _(null);
  let s = null;
  const i = () => {
    s = new ie(h, (w) => {
      e.value = w.address, t.value = w.isDeployed, r.value = w.isPending, n.value = w.error;
    });
  };
  q(() => {
    i();
  }), Q(() => {
    s = null;
  });
  const o = async (w) => {
    if (!s) throw new Error("Core not initialized");
    return s.register(w);
  }, a = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.deploy(w, g);
  }, l = async () => {
    if (!s) throw new Error("Core not initialized");
    return s.login();
  }, u = async (w) => {
    if (!s) throw new Error("Core not initialized");
    return s.signAuthEntry(w);
  }, c = async () => {
    if (!s) throw new Error("Core not initialized");
    return s.getNonce();
  }, f = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.addSigner(w, g);
  }, m = async () => {
    if (!s) throw new Error("Core not initialized");
    return s.getSigners();
  }, A = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.removeSigner(w, g);
  }, R = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.setGuardian(w, g);
  }, b = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.initiateRecovery(w, g);
  }, S = async (w) => {
    if (!s) throw new Error("Core not initialized");
    return s.completeRecovery(w);
  }, E = async (w, g) => {
    if (!s) throw new Error("Core not initialized");
    return s.getAllowance(w, g);
  }, k = async (w, g, P, O, V) => {
    if (!s) throw new Error("Core not initialized");
    return s.approve(w, g, P, O, V);
  };
  return {
    // Reactive state (readonly to prevent direct mutations)
    address: U(e),
    isDeployed: U(t),
    isPending: U(r),
    error: U(n),
    // Methods
    register: o,
    deploy: a,
    login: l,
    signAuthEntry: u,
    getNonce: c,
    addSigner: f,
    getSigners: m,
    removeSigner: A,
    setGuardian: R,
    initiateRecovery: b,
    completeRecovery: S,
    getAllowance: E,
    approve: k
  };
}
export {
  K as NoGuardianSet,
  F as RecoveryNotPending,
  j as RecoveryTimelockActive,
  le as useInvisibleWallet
};
