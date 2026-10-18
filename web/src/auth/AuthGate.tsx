import "@rainbow-me/rainbowkit/styles.css";
import {
  RainbowKitAuthenticationProvider,
  RainbowKitProvider,
  lightTheme,
  type Theme,
} from "@rainbow-me/rainbowkit";
import { useEffect, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { getAccount } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { useLocale } from "../i18n";
import { LoginPage } from "./LoginPage";
import { createSiweAdapter } from "./siweAdapter";
import { loadMe, useAuth } from "./useMe";
import { wagmiConfig } from "./wagmi";

const adapter = createSiweAdapter(() => getAccount(wagmiConfig).address);

const base = lightTheme({ borderRadius: "small", fontStack: "system", overlayBlur: "none" });
/** RainbowKit's modal in the app's tokens, so it follows the light/dark theme like everything else. */
const theme: Theme = {
  ...base,
  colors: {
    accentColor: "var(--accent)",
    accentColorForeground: "var(--on-accent)",
    actionButtonBorder: "var(--line)",
    actionButtonBorderMobile: "var(--line)",
    actionButtonSecondaryBackground: "var(--bg-subtle)",
    closeButton: "var(--fg-muted)",
    closeButtonBackground: "var(--bg-subtle)",
    connectButtonBackground: "var(--bg)",
    connectButtonBackgroundError: "var(--neg)",
    connectButtonInnerBackground: "var(--bg-subtle)",
    connectButtonText: "var(--fg)",
    connectButtonTextError: "var(--on-accent)",
    connectionIndicator: "var(--pos)",
    downloadBottomCardBackground: "var(--bg)",
    downloadTopCardBackground: "var(--bg-subtle)",
    error: "var(--neg)",
    generalBorder: "var(--line)",
    generalBorderDim: "var(--line)",
    menuItemBackground: "var(--bg-subtle)",
    modalBackdrop: "var(--scrim)",
    modalBackground: "var(--bg)",
    modalBorder: "var(--line)",
    modalText: "var(--fg)",
    modalTextDim: "var(--fg-muted)",
    modalTextSecondary: "var(--fg-muted)",
    profileAction: "var(--bg-subtle)",
    profileActionHover: "var(--line)",
    profileForeground: "var(--bg)",
    selectedOptionBorder: "var(--accent)",
    standby: "var(--warn)",
  },
  fonts: { body: "var(--font-sans)" },
  radii: {
    actionButton: "var(--radius)",
    connectButton: "var(--radius)",
    menuButton: "var(--radius)",
    modal: "var(--radius-pop)",
    modalMobile: "var(--radius-pop)",
  },
  shadows: {
    connectButton: "none",
    dialog: "var(--shadow-pop)",
    profileDetailsAction: "none",
    selectedOption: "none",
    selectedWallet: "none",
    walletLogo: "none",
  },
};

/**
 * Wallet sign-in around the app: the shell renders only with a session (`GET /api/auth/me`), the
 * login page otherwise. Any 401 later ends the session (useMe.ts) and lands back here.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const locale = useLocale((s) => s.locale);
  useEffect(() => {
    if (useAuth.getState().status === "loading") void loadMe();
  }, []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <RainbowKitAuthenticationProvider adapter={adapter} status={status}>
        <RainbowKitProvider
          theme={theme}
          locale={locale === "zh" ? "zh-CN" : "en-US"}
          modalSize="compact"
          appInfo={{ appName: "etherGraph" }}
          initialChain={mainnet}
        >
          {status === "authenticated" ? children : status === "loading" ? <main className="login" aria-busy="true" /> : <LoginPage />}
        </RainbowKitProvider>
      </RainbowKitAuthenticationProvider>
    </WagmiProvider>
  );
}
