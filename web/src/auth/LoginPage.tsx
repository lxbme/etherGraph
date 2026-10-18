import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect } from "react";
import { useAccount, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { mainnet } from "wagmi/chains";
import { useT, type MsgKey } from "../i18n";
import { BrandLockup } from "../shell/Brand";
import { SettingsMenu } from "../shell/SettingsMenu";
import { useAuth, type LoginReason } from "./useMe";

const REASONS: Record<LoginReason, MsgKey> = {
  not_whitelisted: "login.reason.notWhitelisted",
  failed: "login.reason.failed",
  rate_limited: "error.rateLimited",
  session_ended: "error.unauthorized",
  network: "error.network",
  wrong_chain: "login.reason.wrongChain",
};

/** The only page without a session: the brand, one "Connect wallet" button and why the user is here. */
export function LoginPage() {
  const t = useT();
  const reason = useAuth((s) => s.reason);
  // RainbowKit's modal: choose a wallet, then sign the server's message (or straight to signing
  // when the wallet is still connected).
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const noWallet = useConnectors().length === 0;
  // `chain` is undefined while the wallet is on a chain we do not configure (only mainnet); RainbowKit's
  // sign-in view then does nothing, so that state never reaches it.
  const { isConnected, chain } = useAccount();
  const offChain = isConnected && !chain;
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  // The wallet left mainnet while the modal is open (or refused to switch when connecting): ask once
  // to switch back; if it will not, start over from choosing a wallet and say why.
  useEffect(() => {
    if (!connectModalOpen || !offChain) return;
    switchChainAsync({ chainId: mainnet.id }).catch(() => {
      useAuth.setState({ reason: "wrong_chain" });
      void disconnectAsync().catch(() => {});
    });
  }, [connectModalOpen, offChain, switchChainAsync, disconnectAsync]);

  // A wallet still connected on another chain (e.g. reconnected on page load) starts from choosing a
  // wallet: RainbowKit then connects it on mainnet, switching the chain.
  const connect = async () => {
    if (offChain) await disconnectAsync().catch(() => {});
    openConnectModal?.();
  };
  return (
    <main className="login">
      <div className="login__settings">
        <SettingsMenu />
      </div>
      <section className="login__card">
        {/* Named explicitly: browsers read the lockup's flex items as separate words ("ether Graph"). */}
        <h1 className="login__brand" aria-label="etherGraph">
          <BrandLockup />
        </h1>
        <p className="login__subtitle">{t("login.subtitle")}</p>
        {reason && (
          <p className="login__reason" role="alert">
            {t(REASONS[reason])}
          </p>
        )}
        <button className="btn btn--primary login__connect" disabled={!openConnectModal} onClick={() => void connect()}>
          {t("login.connect")}
        </button>
        <p className="login__hint">{t(noWallet ? "login.noWallet" : "login.note")}</p>
      </section>
    </main>
  );
}
