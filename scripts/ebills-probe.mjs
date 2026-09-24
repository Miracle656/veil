/**
 * eBills reseller-role probe.
 *
 * The API mints a JWT for any valid account, so a successful login proves
 * nothing. The reseller role is what gates the transactional endpoints, and the
 * cheapest way to test for it is GET /api/v2/balance: it needs the role but
 * costs nothing and vends nothing.
 *
 * Reads credentials from the environment and never prints them, nor the token.
 *
 *   EBILLS_USERNAME=you@example.com EBILLS_PASSWORD=... node scripts/ebills-probe.mjs
 *
 * On Windows PowerShell:
 *   $env:EBILLS_USERNAME='you@example.com'; $env:EBILLS_PASSWORD='...'
 *   node scripts/ebills-probe.mjs
 */
const BASE = 'https://ebills.africa/wp-json';

const username = process.env.EBILLS_USERNAME;
const password = process.env.EBILLS_PASSWORD;

if (!username || !password) {
  console.error('Set EBILLS_USERNAME and EBILLS_PASSWORD in the environment. Nothing was sent.');
  process.exit(2);
}

async function main() {
  console.log('1. Authenticating as', username.replace(/(.{2}).*(@.*)/, '$1***$2'));

  const authRes = await fetch(BASE + '/jwt-auth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const auth = await authRes.json().catch(() => ({}));

  if (!authRes.ok || !auth.token) {
    console.error('   FAILED ' + authRes.status + ' ' + (auth.code || ''));
    console.error('   ' + (auth.message || '').replace(/<[^>]*>/g, ''));
    process.exit(1);
  }

  console.log('   OK — token issued for', auth.user_display_name || auth.user_nicename);
  console.log('   NOTE: this invalidated any token issued earlier. Only the newest one works.');

  console.log('2. Testing for the reseller role via GET /api/v2/balance');
  const balRes = await fetch(BASE + '/api/v2/balance', {
    headers: { Authorization: 'Bearer ' + auth.token },
  });
  const bal = await balRes.json().catch(() => ({}));

  if (balRes.ok && bal.data) {
    console.log('   RESELLER ROLE PRESENT.');
    console.log('   Wallet balance: ' + bal.data.balance + ' ' + bal.data.currency);
    const funded = Number(bal.data.balance) > 0;
    console.log(
      funded
        ? '   Float is funded — a real vend can be attempted.'
        : '   Float is empty. Fund the wallet before any vend; expect 402 insufficient_funds.',
    );
    return;
  }

  if (balRes.status === 403) {
    console.log('   NO RESELLER ROLE (403 ' + (bal.code || 'rest_forbidden') + ').');
    console.log('   Credentials are valid — the account simply lacks the role, or this IP');
    console.log('   is not on the whitelist if you enabled whitelisting.');
    console.log('   Ask support@ebills.africa (or WhatsApp +234 810 536 5830) to grant it.');
    process.exit(1);
  }

  console.log('   Unexpected ' + balRes.status + ' ' + (bal.code || ''));
  console.log('   ' + (bal.message || ''));
  process.exit(1);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
