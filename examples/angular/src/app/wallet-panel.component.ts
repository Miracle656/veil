import { ChangeDetectionStrategy, Component } from '@angular/core';
import { inject } from '@angular/core';

import { VeilService } from 'invisible-wallet-sdk/angular';

import { FeePayerService } from './fee-payer.service';

@Component({
  selector: 'app-wallet-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <h2>Get a wallet</h2>

      <label for="username">Username</label>
      <input #username id="username" placeholder="alice" autocomplete="off" />

      <button
        class="primary"
        [disabled]="wallet.isPending()"
        (click)="register(username.value)"
      >
        {{ wallet.isPending() ? 'Working…' : 'Create' }}
      </button>
      <button
        class="ghost"
        [disabled]="wallet.isPending()"
        (click)="login()"
      >
        {{ wallet.isPending() ? 'Working…' : 'Log in' }}
      </button>

      <p class="hint">
        "Create" registers your passkey and deploys the wallet contract; "Log
        in" signs in an existing wallet. Either way you'll be asked for a
        passkey by your OS.
      </p>
    </section>
  `,
  styles: `
    .panel {
      display: grid;
      gap: 0.75rem;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 1.5rem;
    }

    .panel h2 {
      margin: 0;
      font-size: 1.1rem;
    }

    .ghost {
      background: transparent;
      border: 1px solid #fbbf24;
      color: #fbbf24;
    }

    .ghost:hover {
      background: #fbbf241a;
    }

    .hint {
      margin: 0.5rem 0 0;
      color: #94a3b8;
      font-size: 0.85rem;
    }
  `,
})
export class WalletPanelComponent {
  readonly wallet: VeilService = inject(VeilService);
  readonly feePayer: FeePayerService = inject(FeePayerService);

  /** Register a fresh passkey, then deploy the wallet contract. */
  async register(username: string): Promise<void> {
    await this.wallet.register(username.trim() || undefined);
    const funding = await this.feePayer.ensureFunded();
    await this.wallet.deploy(this.feePayer.readSecret() ?? funding.secret());
  }

  /** Sign in an existing wallet with the stored passkey. */
  async login(): Promise<void> {
    await this.wallet.login();
  }
}