import { createContext, useContext } from 'react';
import type { InvisibleWallet } from '../../src/useInvisibleWallet';

export interface VeilContextValue {
  wallet: InvisibleWallet;
}

export const VeilContext = createContext<VeilContextValue | null>(null);

export function useVeilContext(): VeilContextValue {
  const ctx = useContext(VeilContext);
  if (!ctx) {
    throw new Error('useVeilContext must be used within a VeilProvider');
  }
  return ctx;
}
