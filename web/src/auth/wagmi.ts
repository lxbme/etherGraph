import { createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { custom } from "viem";

/**
 * Browser wallet extensions only, found through EIP-6963 announcements: no WalletConnect (it needs a
 * Reown project id and a third-party relay). The chain transport refuses every call, so nothing in the
 * page (wagmi, RainbowKit's ENS/balance lookups) ever reaches a public RPC: the browser talks to our
 * own server and to the wallet extension, nothing else. Signing goes through the wallet's provider.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: {
    [mainnet.id]: custom(
      {
        request: async ({ method }: { method: string }) => {
          throw new Error(`etherGraph does not use a public RPC (${method})`);
        },
      },
      { retryCount: 0 },
    ),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
