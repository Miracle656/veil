import { Redirect } from 'expo-router';

/**
 * Entry route. Once the wallet/session logic lands this will branch between
 * onboarding and the unlocked tab group; for the navigation shell the landing
 * simply forwards into the (tabs) group so the route tree is exercised.
 */
export default function Entry() {
  return <Redirect href="/dashboard" />;
}
