import { createAuthenticationAdapter } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { api } from "../api/endpoints";
import type { SiweFieldsDto } from "../api/generated/SiweFieldsDto";
import { login, loginFailed, logout } from "./useMe";

/**
 * The EIP-4361 text of the server's fields signed by `address` (D1). The server rebuilds the same text
 * from its stored copy of these fields and accepts only a byte-equal message, so nothing here may be
 * changed or defaulted; crates/eg-server/tests/data/siwe_canonical.json pins both sides.
 */
export function siweMessage(fields: SiweFieldsDto, address: string): string {
  if (fields.version !== "1") throw new Error(`unsupported SIWE version ${fields.version}`);
  return createSiweMessage({
    domain: fields.domain,
    address: address as Address,
    statement: fields.statement,
    uri: fields.uri,
    version: "1",
    chainId: fields.chain_id,
    nonce: fields.nonce,
    issuedAt: new Date(fields.issued_at),
    expirationTime: new Date(fields.expiration_time),
  });
}

/**
 * RainbowKit's sign-in flow against our backend: the nonce request is per address (the wallet must be
 * connected first, which RainbowKit guarantees), the message is the server's fields verbatim, `verify`
 * starts the session and `signOut` ends it.
 */
export function createSiweAdapter(account: () => string | undefined) {
  /** Fields of the nonce RainbowKit currently holds (one sign-in view at a time). */
  let issued: SiweFieldsDto | null = null;
  return createAuthenticationAdapter<string>({
    getNonce: async () => {
      const address = account();
      if (!address) throw new Error("no wallet connected");
      try {
        issued = await api.authNonce(address);
      } catch (e) {
        loginFailed(e);
        throw e;
      }
      return issued.nonce;
    },
    createMessage: ({ nonce, address }) => {
      if (!issued || issued.nonce !== nonce) throw new Error("unknown nonce");
      return siweMessage(issued, address);
    },
    verify: ({ message, signature }) => {
      issued = null;
      return login(message, signature);
    },
    signOut: logout,
  });
}
