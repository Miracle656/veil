/**
 * Tests for the multisig proposal/approval rules.
 *
 * These cover the decisions the screen makes before it ever touches the chain:
 * amount conversion, who may approve, and — the crux of the flow — whether the
 * next approval is the one that executes the transfer. The RPC calls themselves
 * are thin wrappers over the Stellar SDK and are exercised against a real
 * contract, not here.
 */

import { Keypair } from '@stellar/stellar-sdk';

import {
  approvalBlocker,
  formatStroopsAsXlm,
  hasApproved,
  isValidRecipient,
  MultisigError,
  parseXlmToStroops,
  proposalStatus,
  publicKeyFromSecret,
  remainingApprovals,
  STROOPS_PER_XLM,
  willExecuteOnApproval,
  type MultisigDetails,
  type Proposal,
} from '../multisig';

const OWNER_A = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const OWNER_B = 'GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3';
const OWNER_C = 'GAJXBGXV7VQGKPTOSFPVLDDMD7MTLKZDUBWMBBRJRVIMTP4XZ2ZAAGRP';
const OUTSIDER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function multisig(overrides: Partial<MultisigDetails> = {}): MultisigDetails {
  return {
    contractId: CONTRACT,
    owners: [OWNER_A, OWNER_B, OWNER_C],
    threshold: 2,
    balance: 1_000n * STROOPS_PER_XLM,
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    to: OUTSIDER,
    amount: 100n * STROOPS_PER_XLM,
    approvals: [],
    executed: false,
    ...overrides,
  };
}

describe('parseXlmToStroops', () => {
  it('converts whole and fractional amounts exactly', () => {
    expect(parseXlmToStroops('1')).toBe(10_000_000n);
    expect(parseXlmToStroops('12.5')).toBe(125_000_000n);
    expect(parseXlmToStroops('0.0000001')).toBe(1n);
    expect(parseXlmToStroops(' 250 ')).toBe(2_500_000_000n);
  });

  it('keeps precision that float arithmetic would lose', () => {
    // parseFloat('0.7') * 1e7 is 6999999.999999999 — one stroop short after
    // truncation, and wrong in the user's favour or against it at random.
    expect(parseXlmToStroops('0.7')).toBe(7_000_000n);
    expect(parseXlmToStroops('1234567.8912345')).toBe(12_345_678_912_345n);
  });

  it('rejects amounts that are not positive', () => {
    expect(() => parseXlmToStroops('0')).toThrow(MultisigError);
    expect(() => parseXlmToStroops('0.0')).toThrow('greater than zero');
    expect(() => parseXlmToStroops('-5')).toThrow(MultisigError);
  });

  it('rejects malformed input', () => {
    for (const input of ['', '   ', '.', 'abc', '1.2.3', '5 XLM', '1e7']) {
      expect(() => parseXlmToStroops(input)).toThrow(MultisigError);
    }
  });

  it('rejects amounts finer than a stroop', () => {
    expect(() => parseXlmToStroops('0.00000001')).toThrow('7 decimal places');
  });
});

describe('formatStroopsAsXlm', () => {
  it('round-trips with parseXlmToStroops', () => {
    for (const amount of ['1', '12.5', '0.0000001', '1234567.8912345']) {
      expect(formatStroopsAsXlm(parseXlmToStroops(amount))).toBe(amount);
    }
  });

  it('trims trailing zeros rather than padding every balance to seven places', () => {
    expect(formatStroopsAsXlm(0n)).toBe('0');
    expect(formatStroopsAsXlm(10_000_000n)).toBe('1');
    expect(formatStroopsAsXlm(10_500_000n)).toBe('1.05');
  });
});

describe('isValidRecipient', () => {
  it('accepts classic accounts and contracts', () => {
    expect(isValidRecipient(OWNER_A)).toBe(true);
    expect(isValidRecipient(CONTRACT)).toBe(true);
    expect(isValidRecipient(`  ${OWNER_A}  `)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidRecipient('')).toBe(false);
    expect(isValidRecipient('GNOTAREALADDRESS')).toBe(false);
    // A secret key is the dangerous near-miss: it is the right length and shape.
    expect(isValidRecipient(Keypair.random().secret())).toBe(false);
  });
});

describe('publicKeyFromSecret', () => {
  it('derives the address a secret controls', () => {
    const keypair = Keypair.random();
    expect(publicKeyFromSecret(keypair.secret())).toBe(keypair.publicKey());
    expect(publicKeyFromSecret(`  ${keypair.secret()}  `)).toBe(keypair.publicKey());
  });

  it('returns null while a field is still being typed into', () => {
    expect(publicKeyFromSecret('')).toBeNull();
    expect(publicKeyFromSecret('SBTLK')).toBeNull();
    expect(publicKeyFromSecret(OWNER_A)).toBeNull();
  });
});

describe('proposal state', () => {
  it('counts the approvals still outstanding', () => {
    expect(remainingApprovals(proposal(), 2)).toBe(2);
    expect(remainingApprovals(proposal({ approvals: [OWNER_A] }), 2)).toBe(1);
    expect(remainingApprovals(proposal({ approvals: [OWNER_A, OWNER_B] }), 2)).toBe(0);
    // A threshold lowered after the fact must not report a negative shortfall.
    expect(remainingApprovals(proposal({ approvals: [OWNER_A, OWNER_B] }), 1)).toBe(0);
  });

  it('reports where a proposal stands', () => {
    expect(proposalStatus(proposal(), 2)).toBe('pending');
    expect(proposalStatus(proposal({ approvals: [OWNER_A] }), 2)).toBe('pending');
    expect(proposalStatus(proposal({ approvals: [OWNER_A, OWNER_B] }), 2)).toBe('ready');
    expect(proposalStatus(proposal({ executed: true, approvals: [OWNER_A, OWNER_B] }), 2)).toBe(
      'executed'
    );
  });

  it('knows who has already approved', () => {
    const pending = proposal({ approvals: [OWNER_A] });
    expect(hasApproved(pending, OWNER_A)).toBe(true);
    expect(hasApproved(pending, OWNER_B)).toBe(false);
    expect(hasApproved(pending, null)).toBe(false);
  });
});

describe('willExecuteOnApproval', () => {
  it('is true only for the approval that reaches the threshold', () => {
    expect(willExecuteOnApproval(proposal(), 3)).toBe(false);
    expect(willExecuteOnApproval(proposal({ approvals: [OWNER_A] }), 3)).toBe(false);
    expect(willExecuteOnApproval(proposal({ approvals: [OWNER_A, OWNER_B] }), 3)).toBe(true);
  });

  it('is true for the first approval of a 1-of-N wallet', () => {
    expect(willExecuteOnApproval(proposal(), 1)).toBe(true);
  });

  it('is false once the transfer has been made', () => {
    expect(
      willExecuteOnApproval(proposal({ executed: true, approvals: [OWNER_A, OWNER_B] }), 2)
    ).toBe(false);
  });
});

describe('approvalBlocker', () => {
  it('lets an owner who has not yet approved go ahead', () => {
    expect(approvalBlocker(proposal(), multisig(), OWNER_A)).toBeNull();
    expect(approvalBlocker(proposal({ approvals: [OWNER_A] }), multisig(), OWNER_B)).toBeNull();
  });

  it('blocks an executed proposal', () => {
    const done = proposal({ executed: true, approvals: [OWNER_A, OWNER_B] });
    expect(approvalBlocker(done, multisig(), OWNER_C)).toMatch(/already been executed/);
  });

  it('blocks a signer who is not an owner', () => {
    expect(approvalBlocker(proposal(), multisig(), OUTSIDER)).toMatch(/not one of/);
  });

  it('blocks a second approval from the same owner', () => {
    const pending = proposal({ approvals: [OWNER_A] });
    expect(approvalBlocker(pending, multisig(), OWNER_A)).toMatch(/already approved/);
  });

  it('asks for a key when none has been entered', () => {
    expect(approvalBlocker(proposal(), multisig(), null)).toMatch(/Enter an owner secret key/);
  });

  it('blocks the deciding approval when the wallet cannot cover the transfer', () => {
    // The contract would transfer inside this same call and panic, costing a
    // fee for nothing. Catch it before submitting.
    const decisive = proposal({ approvals: [OWNER_A], amount: 500n * STROOPS_PER_XLM });
    const poor = multisig({ balance: 100n * STROOPS_PER_XLM });

    expect(approvalBlocker(decisive, poor, OWNER_B)).toMatch(/does not hold enough XLM/);
  });

  it('allows a non-deciding approval even when the balance is short', () => {
    // The transfer is not attempted yet, and funds can arrive before it is.
    const early = proposal({ amount: 500n * STROOPS_PER_XLM });
    const poor = multisig({ threshold: 3, balance: 100n * STROOPS_PER_XLM });

    expect(approvalBlocker(early, poor, OWNER_A)).toBeNull();
  });
});
