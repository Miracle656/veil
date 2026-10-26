import fs from 'node:fs';
import path from 'node:path';

import { BILL_SERVICES, getServiceAvailabilityMessage } from '../PayForGrid';

const appRoot = path.resolve(__dirname, '../../app');

function routeExists(route: string) {
  const file = route.replace(/^\//, '');
  return [
    path.join(appRoot, `${file}.tsx`),
    path.join(appRoot, `${file}.ts`),
    path.join(appRoot, file, 'index.tsx'),
    path.join(appRoot, file, 'index.ts'),
  ].some((candidate) => fs.existsSync(candidate));
}

describe('PayForGrid service availability', () => {
  it('gives every live service a route that resolves to an Expo Router screen', () => {
    const live = BILL_SERVICES.filter((service) => service.status === 'live');
    expect(live.length).toBeGreaterThan(0);

    for (const service of live) {
      expect(service.route).toBeTruthy();
      expect(routeExists(service.route!)).toBe(true);
    }
  });

  it('explains upcoming services and separates bills the provider does not support', () => {
    const data = BILL_SERVICES.find((service) => service.id === 'data')!;
    const bills = BILL_SERVICES.find((service) => service.id === 'bills')!;

    expect(data.status).toBe('soon');
    expect(getServiceAvailabilityMessage(data)).toMatch(/not available yet.*no payment/i);
    expect(bills.status).toBe('not-planned');
    expect(getServiceAvailabilityMessage(bills)).toMatch(/not supported.*not planned.*no payment/i);
  });
});
