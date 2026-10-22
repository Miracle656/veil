import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { inject } from '@angular/core';

import { VeilService } from 'invisible-wallet-sdk/angular';

import { FeePayerService } from './fee-payer.service';

export type SendStatus = 'idle' | 'pending' | 'unconfirmed' | 'confirmed';

interface PendingSend {
  recipient: string;
  stroops: number;
  secret: string;
}

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
        [disabled]="wallet.isPending() || status() === 'pending'"
        (click)="send(to.value, amount.value)"
      >
        {{ status() === 'pending' ? 'Sending…' : 'Send' }}
      </button>

      @if (status() === 'unconfirmed') {
        <div class="notice unconfirmed" role="alert">
          <p>
            <strong>You may have paid.</strong>
            The network dropped after you approved this payment, so we
            can’t confirm whether it went through. We’ll resolve it as soon as you
            reconnect.
          </p>
          <button class="secondary" (click)="resolve()">Resolve now</button>
        </div>
      }

      @if (status() === 'confirmed') {
        <div class="notice confirmed" role="status">Payment confirmed.</div>
      }
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

    .notice {
      display: grid;
      gap: 0.5rem;
      border-radius: 8px;
      padding: 0.75rem;
      font-size: 0.85rem;
    }

    .notice p {
      margin: 0;
    }

    .notice.unconfirmed {
      background: #422006;
      border: 1px solid #b45309;
      color: #fdedd7;
    }

    .notice.confirmed {
      background: #052e1f;
      border: 1px solid #15803d;
      color: #dcfce7;
    }
  `,
})
export class SendPanelComponent {
  readonly wallet: VeilService = inject(VeilService);
  readonly feePayer: FeePayerService = inject(FeePayerService);

  /** The current state of the most recent send attempt. */
  readonly status = signal<SendStatus>('idle');

  /**
   * The payment that was submitted but whose outcome we could not confirm
   * because the network dropped after the passkey ceremony. Kept so that a
   * reconnect can resolve it instead of leaving the user to guess.
   */
  private pending: PendingSend | null = null;

  /** Send XLM from the passkey wallet to an arbitrary account. */
  async send(to: string, amount: string): Promise<void> {
    const recipient = to.trim();
    const stroops = Math.round(Number(amount) * 10_000_000);
    if (!recipient || !Number.isFinite(stroops)) return;

    this.status.set('pending');
    this.pending = null;

    try {
      const secret = this.feePayer.readSecret();
      if (!secret) {
        const funding = await this.feePayer.ensureFunded();
        await this.wallet.sendPayment(funding.secret(), recipient, stroops);
      } else {
        await this.wallet.sendPayment(secret, recipient, stroops);
      }
      this.status.set('confirmed');
    } catch (err: unknown) {
      // The passkey ceremony has already happened. If the failure is a transport
      // failure we cannot prove the payment did not land, so we report it as
      // 'unconfirmed' rather than 'failed'. Only a definitive rejection from the
      // network counts as a failure.
      if (this.isDisconnect(err)) {
        this.pending = { recipient, stroops, secret: this.feePayer.readSecret() ?? '' };
        this.status.set('unconfirmed');
        return;
      }
      this.status.set('idle');
      throw err;
    }
  }

  /**
   * Attempt to resolve an unconfirmed payment. Called on reconnect and from
   * the 'Resolve now' button. If the network is still down the status stays
   * 'unconfirmed'.
   */
  async resolve(): Promise<void> {
    if (this.status() !== 'unconfirmed') return;
    const pending = this.pending;
    if (!pending || !pending.secret) return;

    try {
      await this.wallet.sendPayment(pending.secret, pending.recipient, pending.stroops);
      this.pending = null;
      this.status.set('confirmed');
    } catch (err: unknown) {
      // Still offline (or the resolve attempt itself failed transport-wise): the
      // payment remains unconfirmed. We never downgrade it to 'failed'.
      if (!this.isDisconnect(err)) throw err;
    }
  }

  /** Detect a transport-level disconnect vs a definitive network rejection. */
  private isDisconnect(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: string }).code;
    if (code === 'NETWORK_ERROR' || code === 'ECONNREFSET') return true;
    const message = (err as { message?: string }).message ?? '';
    return /failed to fetch|network request failed|offline|timed out/i.test(message);
  }
}
