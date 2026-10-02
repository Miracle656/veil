import type { ApplicationConfig } from '@angular/core';
import { provideVeil } from 'invisible-wallet-sdk/angular';

import { environment } from './environment';

export const appConfig: ApplicationConfig = {
  providers: [
    // Standalone bootstrap: provideVeil brings the config token and the
    // DI-provided VeilService, mirroring provideRouter / provideHttpClient.
    provideVeil(environment.wallet),
  ],
};