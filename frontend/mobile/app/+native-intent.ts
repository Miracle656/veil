import { FALLBACK_ROUTE, resolveDeepLink } from '../lib/deepLinks';

/**
 * expo-router calls this for every inbound deep link before it builds any
 * navigation state — on a cold start (`initial: true`) and on a warm resume
 * (`initial: false`) alike. Returning a normalised in-app path here is what
 * makes both paths land on the same screen.
 *
 * It runs during launch, so it must never throw and must never block:
 * {@link resolveDeepLink} is pure, synchronous, and falls back to the home
 * route instead of raising.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string {
  try {
    return resolveDeepLink(path, { initial });
  } catch {
    return FALLBACK_ROUTE;
  }
}
