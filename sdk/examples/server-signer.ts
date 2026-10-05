/**
 * Server-side signing for the SDK's `TransactionSigner`.
 *
 * Run this on YOUR backend (the only place the fee-payer secret lives) and
 * expose it behind your own authenticated endpoint. The browser or phone app
 * never sees the secret; its `signTransaction` callback just POSTs the XDR here.
 *
 *   FEE_PAYER_SECRET=S… npx tsx sdk/examples/server-signer.ts <xdr> <networkPassphrase>
 */
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/** Backend: sign an envelope with the key held in the server's environment. */
export function signOnServer(xdr: string, networkPassphrase: string, secret: string): string {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    // Apply YOUR policy here: check the source account, operations and amounts,
    // and throw to refuse. The SDK surfaces the error and submits nothing.
    tx.sign(Keypair.fromSecret(secret));
    return tx.toXDR();
}

/*
 * Client: the signer the SDK is given. No secret in the bundle.
 *
 *   const feePayer: TransactionSigner = {
 *     publicKey: FEE_PAYER_PUBLIC_KEY,            // a G… address is public
 *     signTransaction: async (xdr, { networkPassphrase }) => {
 *       const res = await fetch('/api/sign', {
 *         method: 'POST',
 *         headers: { 'content-type': 'application/json' },
 *         body: JSON.stringify({ xdr, networkPassphrase }),
 *       });
 *       if (!res.ok) throw new Error('Signing was refused');
 *       return (await res.json()).signedXdr;
 *     },
 *   };
 *   await wallet.deploy(feePayer);
 *   await wallet.sendPayment(feePayer, to, amountInStroops);
 */

if (require.main === module) {
    const [xdr, passphrase] = process.argv.slice(2);
    const secret = process.env.FEE_PAYER_SECRET;
    if (!xdr || !passphrase || !secret) {
        console.error('usage: FEE_PAYER_SECRET=S… server-signer.ts <xdr> <networkPassphrase>');
        process.exit(1);
    }
    console.log(signOnServer(xdr, passphrase, secret));
}
