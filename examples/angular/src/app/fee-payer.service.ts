import { Injectable } from '@angular/core';
import { Horizon, Keypair } from '@stellar/stellar-sdk';

import { environment } from './environment';

const FEE_PAYER_KEY = 'veil_fee_payer_secret';

/**
 * Injectable in its own right, so the example shows two services cooperating
 * through DI: the root-provided `FeePayerService` and the `VeilService`
 * provided by `provideVeil` in app.config.ts.
 */
@Injectable({ providedIn: 'root' })
export class FeePayerService {
  /** A funded keypair the wallet contract can use to pay deploy gas. */
  async ensureFunded(): Promise<Keypair> {
    const cached = this.readSecret();
    if (cached) return Keypair.fromSecret(cached);

    const keypair = Keypair.random();
    const horizon = new Horizon.Server(environment.horizonUrl);

    try {
      const account = await horizon.loadAccount(keypair.publicKey());
      if (Number(account.balances.find((b) => b.asset_type === 'native')?.balance ?? 0) > 1) {
        this.saveSecret(keypair.secret());
        return keypair;
      }
    } catch {
      // Unknown account — fund it below.
    }

    await fetch(`${environment.horizonUrl}/friendbot?addr=${keypair.publicKey()}`);
    this.saveSecret(keypair.secret());
    return keypair;
  }

  readSecret(): string | null {
    return localStorage.getItem(FEE_PAYER_KEY);
  }

  private saveSecret(secret: string): void {
    localStorage.setItem(FEE_PAYER_KEY, secret);
  }
}