import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * Entry point for inbound payment requests: `veil://pay?…`,
 * `https://app.veil.xyz/pay?…`, and SEP-7 `web+stellar:pay?…` URIs, all of
 * which `lib/deepLinks.ts` normalises onto this route.
 *
 * It deliberately holds no UI of its own — it hands the request to the send
 * screen so the form arrives prefilled. Full SEP-7 validation of the original
 * URI (address checksums, amount ranges, callback safety) is the job of the
 * handler in backlog #38, which will read the raw `uri` parameter forwarded
 * here and can then replace this redirect with a confirmation step.
 */
export default function Pay() {
  const params = useLocalSearchParams<{
    to?: string;
    amount?: string;
    asset?: string;
    memo?: string;
  }>();

  const forwarded: Record<string, string> = {};
  for (const key of ["to", "amount", "asset", "memo"] as const) {
    const value = params[key];
    if (typeof value === "string" && value) forwarded[key] = value;
  }

  return <Redirect href={{ pathname: "/send", params: forwarded }} />;
}
