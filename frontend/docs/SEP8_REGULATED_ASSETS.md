# SEP-8 Regulated Assets Support

## Overview

Veil supports SEP-8 (Stellar Ecosystem Proposal 8) regulated assets, enabling compliance with regulatory requirements for tokenized securities, equities, and other permissioned assets. When a user attempts to transact a regulated asset, the wallet submits the transaction to the issuer's approval server for compliance verification.

**Key Design Principle:** Veil collects no identity data. When user action is required (e.g., KYC), the wallet opens the issuer's approval URL in a browser—the user interacts directly with the issuer, not through Veil.

## What Are Regulated Assets?

Regulated assets require issuer authorization on a per-transaction basis. The issuer's account has two flags set:
- **AUTHORIZATION_REQUIRED**: Every trustline must be authorized
- **AUTHORIZATION_REVOCABLE**: Issuer can revoke authorization

Common use cases:
- Tokenized securities (stocks, bonds)
- Restricted equities (employee stock plans)
- Government-issued digital assets (CBDC, DTCC assets)
- Compliant stablecoins

## How It Works

### 1. Asset Discovery

The wallet detects a regulated asset by:
1. Checking the issuer's authorization flags (both `auth_required` and `auth_revocable` set)
2. Looking up the asset in the issuer's SEP-1 `stellar.toml` file
3. Finding the `approval_server` URL for that asset

```toml
# Example stellar.toml
[[CURRENCIES]]
code = "USDT"
issuer = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2BRUY4DQAT2B"
regulated = true
approval_server = "https://issuer.example.com/sep8/tx_approve"
approval_criteria = "US persons and KYC-verified entities only"
```

### 2. Transaction Submission

When a user initiates a transaction involving a regulated asset:
1. Wallet creates an unsigned transaction
2. Wallet submits it to the issuer's approval server
3. Server returns one of five outcomes

### 3. Five Possible Outcomes

#### Success
✅ Transaction approved and signed by issuer
- Wallet can submit to the network

#### Revised
⚠️ Transaction was modified to be compliant
- Wallet shows the changes to the user
- **Critical:** Wallet re-verifies the revised transaction before asking user to sign
- User signs the revised transaction if they approve
- Wallet resubmits

#### Pending
⏱️ Issuer cannot determine approval yet
- Wallet waits the suggested time (or retries immediately)
- Wallet resubmits the same transaction later

#### Action Required
🔗 User must complete an action
- Wallet opens the issuer's approval URL in browser
- User completes KYC, email verification, or other action
- User returns to wallet and retries the transaction

#### Rejected
❌ Transaction cannot be approved or revised
- Wallet displays the issuer's error message
- User must modify the transaction and retry

## Implementation Guide

### SDK Usage

The SDK provides the `submitSep8Transaction()` function for approval server communication:

```typescript
import {
  submitSep8Transaction,
  verifyRevisedTransaction,
  isRegulatedAsset,
} from 'invisible-wallet-sdk';

// Check if an asset is regulated
const isRegulated = isRegulatedAsset(issuerAccount.flags);

// Submit transaction for approval
const response = await submitSep8Transaction({
  approvalServerUrl: 'https://issuer.example.com/sep8/tx_approve',
  transactionXdr: unsignedTxXdr,
  timeoutMs: 10_000, // Optional, defaults to 10 seconds
});

// Handle response
switch (response.status) {
  case 'success':
    // Transaction approved and signed by issuer
    await submitToNetwork(response.tx);
    break;

  case 'revised':
    // Verify the revision before asking user to sign
    if (!verifyRevisedTransaction(originalXdr, response.tx)) {
      throw new Error('Revised transaction looks suspicious');
    }
    // Show user the message
    showMessage(response.message);
    // Ask user to sign
    const signed = await getUserSignature(response.tx);
    // Resubmit with signature
    break;

  case 'pending':
    // Retry after timeout
    setTimeout(() => {
      retry(); // Resubmit same transaction
    }, response.timeout ?? 5000);
    break;

  case 'action_required':
    // Open browser for user action
    window.open(response.action_url, '_blank');
    // User returns and retries
    break;

  case 'rejected':
    // Show error to user
    showError(`Cannot approve transaction: ${response.error}`);
    break;
}
```

### Transaction Verification

When the server returns a revised transaction, the wallet MUST re-verify it before signing:

```typescript
import { verifyRevisedTransaction } from 'invisible-wallet-sdk';

if (!verifyRevisedTransaction(originalXdr, revisedXdr)) {
  // Significant changes were made
  console.warn('Approval server made substantial modifications');
  if (!confirm('Do you want to review the changes?')) {
    throw new Error('User rejected revised transaction');
  }
  // Show detailed diff to user
}
```

The verification checks that:
- Source account is unchanged
- Original operations are preserved in order
- Only authorization/deauthorization operations were added

### Frontend Components

#### Trustline Request with Approval

When a user tries to add a trustline to a regulated asset:

```tsx
import { RegulatedAssetApproval } from '@/components/RegulatedAssetApproval';

<RegulatedAssetApproval
  asset={{
    code: 'USDT',
    issuer: 'GBUQWP3...',
    issuername: 'MyIssuer',
  }}
  approvalServerUrl="https://issuer.example.com/sep8/tx_approve"
  onApprovalSuccess={() => {
    // User granted approval, can add trustline
  }}
  onApprovalError={(error) => {
    // Show error message
  }}
/>
```

#### Transaction with Approval

When a user initiates a payment with a regulated asset:

```tsx
<RegulatedAssetTransaction
  transaction={unsignedTx}
  asset={{
    code: 'USDT',
    issuer: 'GBUQWP3...',
  }}
  approvalServerUrl="https://issuer.example.com/sep8/tx_approve"
  onSuccess={() => {
    // Transaction approved and signed by issuer
    // Ready to submit to network
  }}
/>
```

## Security Considerations

### No Identity Data in Veil

✅ **Required:** When action is required (KYC, email verification), the wallet opens the issuer's URL in a browser.
- User interacts directly with issuer
- Veil never receives identity information
- No personal data stored in Veil

❌ **Never:** Asking the user to enter KYC data in the wallet and sending it to the approval server through Veil.

### Revised Transaction Verification

✅ **Required:** Always verify revised transactions before signing.
- Check that source account is unchanged
- Ensure original operations weren't modified
- Alert user if substantial changes detected

❌ **Never:** Automatically sign a revised transaction without user review.

### Approval Server Trust

- Use HTTPS only (enforced)
- Validate URL against asset's stellar.toml
- Timeout requests after 10 seconds (configurable)
- Show issuer name/icon from stellar.toml before opening approval URL

## Error Handling

### Approval Server Errors

The SDK wraps approval server errors in `Sep8Error`:

```typescript
import { Sep8Error } from 'invisible-wallet-sdk';

try {
  const response = await submitSep8Transaction({...});
} catch (error) {
  if (error instanceof Sep8Error) {
    console.error('Approval server error:', error.approvalServerError);
    console.error('HTTP status:', error.status);
    console.error('Reason:', error.message);
  }
}
```

### Network Issues

- **Timeout (>10s):** Show "Approval server not responding" message
- **Connection error:** Show "Unable to contact issuer" message
- **Invalid response:** Show "Invalid response from issuer" message

## Testing

### Testnet Regulated Asset

A test regulated asset is deployed on testnet for development:

- **Code:** `RAST` (Regulated Asset for Stellar Testing)
- **Issuer:** `GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH`
- **Approval Server:** `https://testnet-sep8.example.com/tx_approve`

### Mock Approval Server for Development

Use the mock server for testing without a real issuer:

```typescript
// Mock success response
const mockResponse = {
  status: 'success' as const,
  tx: signedXdr,
  message: 'Transaction approved',
};

// In tests, stub fetch
global.fetch = jest.fn().mockResolvedValueOnce({
  status: 200,
  headers: new Map([['content-type', 'application/json']]),
  json: () => Promise.resolve(mockResponse),
});
```

## Future Enhancements

1. **Action URL POST Support:** Direct POST of KYC fields (optional) without browser redirect
2. **Multi-Regulated-Asset Transactions:** Handle transactions with multiple regulated assets
3. **Approval Caching:** Cache approval decisions within short time window
4. **Custom Thresholds:** Allow issuer to set velocity limits, amount caps
5. **Asset Icon Display:** Show issuer logo during approval flow

## References

- [SEP-8 Specification](https://stellar.org/protocol/sep-8)
- [SEP-1 Stellar Info File](https://stellar.org/protocol/sep-1)
- [Stellar Documentation](https://developers.stellar.org/)

## Support

For issues or questions about SEP-8 support:
1. Check the test cases in `sdk/src/__tests__/sep8.test.ts`
2. Review example implementations in the test suite
3. File an issue on GitHub with minimal reproduction case
