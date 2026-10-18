import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useConnectors } from "wagmi";
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
};

/** The only page without a session: the brand, one "Connect wallet" button and why the user is here. */
export function LoginPage() {
  const t = useT();
  const reason = useAuth((s) => s.reason);
  // RainbowKit's modal: choose a wallet, then sign the server's message (or straight to signing
  // when the wallet is still connected).
  const { openConnectModal } = useConnectModal();
  const noWallet = useConnectors().length === 0;
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
        <button className="btn btn--primary login__connect" disabled={!openConnectModal} onClick={openConnectModal}>
          {t("login.connect")}
        </button>
        <p className="login__hint">{t(noWallet ? "login.noWallet" : "login.note")}</p>
      </section>
    </main>
  );
}
