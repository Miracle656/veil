import fs from 'node:fs';
import path from 'node:path';

describe('Settings page theme tokens', () => {
  it('does not contain hard-coded dark-theme rgba(246,247,248) colours', () => {
    const pagePath = path.resolve(__dirname, '../page.tsx');
    const source = fs.readFileSync(pagePath, 'utf8');

    expect(source).not.toMatch(/rgba\(\s*246\s*,\s*247\s*,\s*248/i);
  });
});
