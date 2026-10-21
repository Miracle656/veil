import {
  canRemoveSigner,
  addSigner,
  removeSigner,
  formatSpendLimit,
  type Signer,
} from "../signers";

const SIGNER_A: Signer = {
  key: "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  label: "Primary passkey",
  spendLimit: null,
  canSign: true,
};

const INVALID_KEY = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("signers lib", () => {
  describe("addSigner", () => {
    test("adds a new signer to the list", () => {
      const next = addSigner([SIGNER_A], {
        key: INVALID_KEY,
        label: "Session key",
        spendLimit: "1000000000",
        canSign: true,
      });
      expect(next).length(2);
      expect(next[1].key).toBe(INVALID_KEY);
    });

    test("does not mutate the input array", () => {
      const original = [SIGNER_A];
      addSigner(original, {
        key: INVALID_KEY,
        spendLimit: null,
        canSign: true,
      });
      expect(original).length(1);
    });

    test("rejects a duplicate key", () => {
      expect(() => addSigner([SIGNER_A], SIGNER_A)).toThrow(/already exists/);
    });
  });

  describe("removeSigner", () => {
    test("removes a key by its full address", () => {
      const second: Signer = {
        key: INVALID_KEY,
        spendLimit: "500000000",
        canSign: true,
      };
      const next = removeSigner([SIGNER_A, second], second.key);
      expect(next).toEqual([SIGNER_A]);
    });

    test("removed key is no longer present and cannot sign", () => {
      const second: Signer = {
        key: INVALID_KEY,
        spendLimit: null,
        canSign: true,
      };
      const next = removeSigner([SIGNER_A, second], second.key);
      expect(next.some((s) => s.key === second.key)).toBe(false);
      // The removed key must not be able to sign afterwards.
      expect(next.every((s) => s.key !== second.key)).toBe(true);
    });

    test("throws when the key is not found", () => {
      expect(() => removeSigner([SIGNER_A], INVALID_KEY)).toThrow(/not found/);
    });
  });

  describe("canRemoveSigner", () => {
    test("allows removing when more than one signer exists", () => {
      const result = canRemoveSigner([SIGNER_A, { key: INVALID_KEY, spendLimit: null, canSign: true }]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("prevents removing the only signer with a reason", () => {
      const result = canRemoveSigner([SIGNER_A]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/last signer/i);
    });

    test("prevents removing when the list is empty", () => {
      const result = canRemoveSigner([]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/last signer/i);
    });
  });

  describe("formatSpendLimit", () => {
    test("returns a placeholder when no limit is set", () => {
      expect(formatSpendLimit(null)).toBe("Unlimited");
      expect(formatSpendLimit(undefined)).toBe("Unlimited");
    });

    test("formats a string limit with the correct decimals", () => {
      expect(formatSpendLimit("1000000000")).toBe("100.0000000");
    });

    test("formats a bigint limit", () => {
      expect(formatSpendLimit(1000000000n)).toBe("100.0000000");
    });
  });
});
