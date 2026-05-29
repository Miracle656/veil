/**
 * WebAuthn Virtual Authenticator Helpers
 * 
 * Utilities for managing virtual authenticators in Playwright tests.
 * These helpers simulate WebAuthn/passkey behavior without requiring
 * physical biometric hardware.
 */

import type { BrowserContext, CDPSession, Page } from '@playwright/test';

export interface VirtualAuthenticator {
  cdpSession: CDPSession;
  authenticatorId: string;
}

export interface WebAuthnCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
  largeBlob?: string;
}

/**
 * Add a virtual WebAuthn authenticator to a page.
 * 
 * @param page - The Playwright page to attach the authenticator to
 * @param options - Optional authenticator configuration
 * @returns The CDP session and authenticator ID
 */
export async function addVirtualAuthenticator(
  page: Page,
  options?: {
    protocol?: 'ctap2' | 'u2f';
    transport?: 'usb' | 'nfc' | 'ble' | 'internal';
    hasResidentKey?: boolean;
    hasUserVerification?: boolean;
    isUserVerified?: boolean;
    automaticPresenceSimulation?: boolean;
  }
): Promise<VirtualAuthenticator> {
  const cdpSession = await page.context().newCDPSession(page);
  
  await cdpSession.send('WebAuthn.enable', { enableUI: false });
  
  const { authenticatorId } = await cdpSession.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options?.protocol ?? 'ctap2',
      transport: options?.transport ?? 'internal',
      hasResidentKey: options?.hasResidentKey ?? true,
      hasUserVerification: options?.hasUserVerification ?? true,
      isUserVerified: options?.isUserVerified ?? true,
      automaticPresenceSimulation: options?.automaticPresenceSimulation ?? true,
    },
  });
  
  return { cdpSession, authenticatorId };
}

/**
 * Get all credentials stored in a virtual authenticator.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 * @returns Array of credentials
 */
export async function getCredentials(
  cdpSession: CDPSession,
  authenticatorId: string
): Promise<WebAuthnCredential[]> {
  const { credentials } = await cdpSession.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  return credentials;
}

/**
 * Add a credential to a virtual authenticator.
 * This simulates syncing a credential from another device.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 * @param credential - The credential to add
 */
export async function addCredential(
  cdpSession: CDPSession,
  authenticatorId: string,
  credential: WebAuthnCredential
): Promise<void> {
  await cdpSession.send('WebAuthn.addCredential', {
    authenticatorId,
    credential,
  });
}

/**
 * Remove a credential from a virtual authenticator.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 * @param credentialId - The credential ID to remove
 */
export async function removeCredential(
  cdpSession: CDPSession,
  authenticatorId: string,
  credentialId: string
): Promise<void> {
  await cdpSession.send('WebAuthn.removeCredential', {
    authenticatorId,
    credentialId,
  });
}

/**
 * Clear all credentials from a virtual authenticator.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 */
export async function clearCredentials(
  cdpSession: CDPSession,
  authenticatorId: string
): Promise<void> {
  await cdpSession.send('WebAuthn.clearCredentials', {
    authenticatorId,
  });
}

/**
 * Remove a virtual authenticator.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 */
export async function removeVirtualAuthenticator(
  cdpSession: CDPSession,
  authenticatorId: string
): Promise<void> {
  await cdpSession.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId,
  });
}

/**
 * Set the user verification state of a virtual authenticator.
 * 
 * @param cdpSession - The CDP session
 * @param authenticatorId - The authenticator ID
 * @param isUserVerified - Whether the user is verified
 */
export async function setUserVerified(
  cdpSession: CDPSession,
  authenticatorId: string,
  isUserVerified: boolean
): Promise<void> {
  await cdpSession.send('WebAuthn.setUserVerified', {
    authenticatorId,
    isUserVerified,
  });
}

/**
 * Disable WebAuthn in the CDP session.
 * 
 * @param cdpSession - The CDP session
 */
export async function disableWebAuthn(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('WebAuthn.disable');
}
