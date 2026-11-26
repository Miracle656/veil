import { ChangeDetectionStrategy, Component } from '@angular/core';
import { inject } from '@angular/core';

import { VeilService } from 'invisible-wallet-sdk/angular';

import { FeePayerService } from './fee-payer.service';

@Component({
  selector: 'app-send-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <h2>Send payment</h2>

      <div class="row">
        <div class="field">
          <label for="to">To (G&hellip; address)</label>
          <input #to id="to" placeholder="G&hellip;" autocomplete="off" />
        </div>
        <div class="field narrow">
          <label for="amount">Amount (XLM)</label>
          <input #amount id="amount" type="number" min="0" step="0.0001" />
        </div>
      </div>

      <button
        class="primary"
        [disabled]="wallet.isPending()"
        (click)="send(to.value, amount.value)"
      >
        {{ wallet.isPending() ? 'Sending…' : 'Send' }}
      </button>
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

    .row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 0.75rem;
    }

    @media (max-width: 480px) {
      .row {
        grid-template-columns: 1fr;
      }
    }

    .field {
      display: grid;
      gap: 0.3rem;
      min-width: 0;
    }
  `,
})
export class SendPanelComponent {
  readonly wallet: VeilService = inject(VeilService);
  readonly feePayer: FeePayerService = inject(FeePayerService);

  /** Send XLM from the passkey wallet to an arbitrary account. */
  async send(to: string, amount: string): Promise<void> {
    const recipient = to.trim();
    const stroops = Math.round(Number(amount) * 10_000_000);
    if (!recipient || !Number.isFinite(stroops)) return;

    const secret = this.feePayer.readSecret();
    if (!secret) {
      const funding = await this.feePayer.ensureFunded();
      await this.wallet.sendPayment(funding.secret(), recipient, stroops);
      return;
    }
    await this.wallet.sendPayment(secret, recipient, stroops);
  }
}