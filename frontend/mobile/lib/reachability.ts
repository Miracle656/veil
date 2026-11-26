/**
 * How the app decides the internet is reachable.
 *
 * The first attempt checked Horizon's root with NetInfo's default HEAD request
 * and required a 200. Horizon answers HEAD on its root with 405, so every check
 * failed, and testers on working Wi-Fi and mobile data were parked on the offline
 * screen, where "Try again" re-ran the same failing check.
 *
 * Reachability only needs to know that a server answered. Any HTTP status proves
 * the device got a response, so any status counts; only a request that times out
 * or cannot connect means offline. GET, because some servers refuse HEAD.
 */

export const REACHABILITY_URL = 'https://horizon.stellar.org/';

/** Any HTTP response at all means the network is reachable. */
export async function isReachableResponse(response: { status: number }): Promise<boolean> {
  return response.status > 0;
}

export const reachabilityConfig = {
  useNativeReachability: false,
  reachabilityUrl: REACHABILITY_URL,
  reachabilityMethod: 'GET' as const,
  reachabilityTest: isReachableResponse,
  reachabilityRequestTimeout: 15_000,
};
