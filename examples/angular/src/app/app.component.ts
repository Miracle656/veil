import { ChangeDetectionStrategy, Component } from '@angular/core';
import { inject } from '@angular/core';

import { VeilService } from 'invisible-wallet-sdk/angular';

import { SendPanelComponent } from './send-panel.component';
import { WalletPanelComponent } from './wallet-panel.component';

/**
 * Shell of the starter. Owns the VeilService through DI and lets the signal
 * returned by `wallet.address()` decide which panel is mounted — a fresh
 * wallet registers/logs in, an existing one sends payments.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [WalletPanelComponent, SendPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="shell">
      <h1>Veil&nbsp;&middot; Angular</h1>
      <p class="lede">
        A passkey wallet driven by the DI-injected <code>VeilService</code>.
      </p>

      @if (wallet.address(); as address) {
        <p class="address">
          Wallet <code>{{ address }}</code>
          <span>{{ wallet.isDeployed() ? '· live' : '· not deployed yet' }}</span>
        </p>
        <app-send-panel />
      } @else {
        <app-wallet-panel />
      }

      @if (wallet.error(); as error) {
        <p class="error" role="alert">{{ error }}</p>
      }
    </main>
  `,
  styles: `
    .shell {
      max-width: 640px;
      margin: 0 auto;
      padding: 4rem 1.5rem;
      display: grid;
      gap: 1.25rem;
    }

    h1 {
      margin: 0;
      font-size: 2rem;
    }

    .lede {
      margin: 0;
      color: #94a3b8;
    }

    .address {
      margin: 0;
      word-break: break-all;
    }

    .address span {
      color: #4ade80;
      font-weight: 600;
    }

    .error {
      margin: 0;
      color: #f87171;
      background: #450a0a33;
      border: 1px solid #7f1d1d;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      word-break: break-word;
    }
  `,
})
export class AppComponent {
  // Constructor-less component: Angular's inject() at the field position keeps
  // the class trivially portable to any testing harness.
  readonly wallet: VeilService = inject(VeilService);
}