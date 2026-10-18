import type { Page } from "@playwright/test";
import { hexToString, isHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const FAKE_WALLET_NAME = "Test Wallet";

export interface FakeWallet {
  /** The wallet's account (checksummed), from a key generated for this test only. */
  address: Address;
  /** Every message the page asked the wallet to sign (`personal_sign`), as text. */
  signed: string[];
}

/** A one-colour square, inline: wallets announce their icon as a data URI (EIP-6963). */
const ICON =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#888"/></svg>');

/**
 * Installs a browser wallet extension stand-in before the page loads: an EIP-1193 provider announced via
 * EIP-6963. Its `personal_sign` is answered in Node by an account whose private key is generated per
 * call, so no real key is ever involved.
 */
export async function installFakeWallet(page: Page): Promise<FakeWallet> {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: string[] = [];
  await page.exposeFunction("__egFakeWalletSign", async (data: string) => {
    const message = isHex(data) ? hexToString(data as Hex) : data;
    signed.push(message);
    return account.signMessage({ message });
  });
  await page.addInitScript(
    ({ address, name, icon }) => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Listener[]>();
      const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((fn) => fn(...args));
      let connected = false;
      const permissions = () => [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [address] }] }];
      const sign = (window as unknown as { __egFakeWalletSign(data: string): Promise<string> }).__egFakeWalletSign;
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case "eth_requestAccounts":
              connected = true;
              emit("connect", { chainId: "0x1" });
              return [address];
            case "eth_accounts":
              return connected ? [address] : [];
            case "eth_chainId":
              return "0x1";
            case "net_version":
              return "1";
            case "wallet_requestPermissions":
              connected = true;
              return permissions();
            case "wallet_getPermissions":
              return connected ? permissions() : [];
            case "wallet_revokePermissions":
              connected = false;
              return null;
            case "wallet_switchEthereumChain":
              return null;
            case "personal_sign":
              return sign(String(params?.[0]));
            default:
              throw Object.assign(new Error(`${method} is not supported by the test wallet`), { code: 4200 });
          }
        },
        on(event: string, fn: Listener) {
          listeners.set(event, [...(listeners.get(event) ?? []), fn]);
          return provider;
        },
        removeListener(event: string, fn: Listener) {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
          return provider;
        },
      };
      const info = { uuid: "6d1c7a3e-2b8f-4f0a-9c55-0e6f3b2a7d41", name, icon, rdns: "org.ethergraph.testwallet" };
      const announce = () =>
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { address: account.address, name: FAKE_WALLET_NAME, icon: ICON },
  );
  return { address: account.address, signed };
}
