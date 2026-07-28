import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { WalletConnectApprovalModal } from "../components/WalletConnectApprovalModal";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      {/* Mounted once at the root so a dApp request is presented for approval
          no matter which screen the user is on. */}
      <WalletConnectApprovalModal />
      <StatusBar style="light" />
    </>
  );
}
