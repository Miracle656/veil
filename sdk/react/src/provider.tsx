import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VeilContext } from './context';
import { useInvisibleWallet, type WalletConfig } from '../../src/useInvisibleWallet';

export interface VeilProviderProps {
  config: WalletConfig;
  queryClient?: QueryClient;
  children: ReactNode;
}

export function VeilProvider({ config, queryClient, children }: VeilProviderProps) {
  const client = queryClient ?? new QueryClient();
  const wallet = useInvisibleWallet(config);

  return (
    <QueryClientProvider client={client}>
      <VeilContext.Provider value={{ wallet }}>
        {children}
      </VeilContext.Provider>
    </QueryClientProvider>
  );
}
