export type FeePayerMode = 'prf-raw' | 'prf-hkdf' | 'legacy';

export type FeePayerProbeStatus = 'exists' | 'not-found' | 'network-error' | 'not-probed';

export type FeePayerCandidateResult = {
  mode: FeePayerMode;
  publicKey: string;
  status: FeePayerProbeStatus;
};

export type FeePayerDiagnostics = {
  at: string;
  prfAttempted: boolean;
  prfOutcome: 'success' | 'unavailable' | 'error' | null;
  prfError?: string;
  probed: boolean;
  candidates: FeePayerCandidateResult[];
  chosenMode: FeePayerMode;
  chosenPublicKey: string;
};

export { deriveFeePayerKeypair } from './deriveFeePayer';
