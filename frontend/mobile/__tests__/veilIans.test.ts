import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COLLECTION_SIZE,
  FIGURES,
  figureImageUrl,
  figureMetadataUrl,
  pad,
} from '../lib/veilIansFigures';
import { formatUsdc, veilIanErrorMessage } from '../lib/veilIans';

/**
 * `lib/veilIansFigures.ts` is a copy of the collection's source of truth. This
 * is what makes the copy safe: edit a trait at the source and forget to copy
 * it, and the app describes a figure the token does not match.
 */
const traits = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'brand', 'veil-masquerade', 'traits.json'),
    'utf8',
  ),
) as {
  collection: { size: number };
  tokens: {
    id: number;
    crown: string;
    aperture: string;
    ornament: string;
    palette: string;
    hem: string;
    image: string;
  }[];
};

describe('FIGURES matches brand/veil-masquerade/traits.json', () => {
  it('has the same number of figures the collection declares', () => {
    expect(COLLECTION_SIZE).toBe(traits.collection.size);
    expect(FIGURES).toHaveLength(traits.tokens.length);
  });

  it('carries every trait of every figure, unchanged', () => {
    for (const token of traits.tokens) {
      expect(FIGURES.find((f) => f.id === token.id)).toEqual({
        id: token.id,
        crown: token.crown,
        aperture: token.aperture,
        ornament: token.ornament,
        palette: token.palette,
        hem: token.hem,
      });
    }
  });

  it('is in id order, because the grid indexes by position', () => {
    expect(FIGURES.map((f) => f.id)).toEqual(traits.tokens.map((_, i) => i + 1));
  });

  it('points at the files the contract points at', () => {
    // The app must load the same image a marketplace would, so these are built
    // from the same base the contract was initialized with.
    for (const token of traits.tokens) {
      expect(figureImageUrl(token.id)).toBe(
        `https://app.useveilapp.xyz/masquerade/${token.image}`,
      );
      expect(figureMetadataUrl(token.id)).toBe(
        `https://app.useveilapp.xyz/masquerade/${pad(token.id)}.json`,
      );
    }
  });
});

describe('veilIanErrorMessage', () => {
  const COLLECTION = 'CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN';
  const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

  it('reads the collection’s own codes', () => {
    expect(
      veilIanErrorMessage(new Error(`Error(Contract, #4) in ${COLLECTION}`), COLLECTION),
    ).toMatch(/already bought/);
    expect(
      veilIanErrorMessage(new Error(`Error(Contract, #5) in ${COLLECTION}`), COLLECTION),
    ).toMatch(/need a Veil name/);
  });

  it('refuses a code that came from another contract', () => {
    // The SAC's #4 is not AlreadySold. Telling a buyer "somebody already bought
    // that figure" when the real problem is their balance sends them away from
    // the thing they can actually fix.
    expect(
      veilIanErrorMessage(new Error(`Error(Contract, #4) in ${USDC_SAC}`), COLLECTION),
    ).toBeNull();
  });

  it('returns null for a code the collection does not define', () => {
    expect(
      veilIanErrorMessage(new Error(`Error(Contract, #10) in ${COLLECTION}`), COLLECTION),
    ).toBeNull();
  });

  it('returns null rather than guess when there is no code', () => {
    expect(veilIanErrorMessage(new Error('Network request failed'), COLLECTION)).toBeNull();
    expect(veilIanErrorMessage(null, COLLECTION)).toBeNull();
  });
});

describe('formatUsdc', () => {
  it('renders whole amounts without a decimal tail', () => {
    expect(formatUsdc(50_000_000n)).toBe('5');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('keeps a fractional balance readable', () => {
    expect(formatUsdc(50_500_000n)).toBe('5.05');
    expect(formatUsdc(1n)).toBe('0.0000001');
  });
});
