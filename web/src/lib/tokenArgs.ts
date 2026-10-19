// Which decoded arguments are ERC-20 amounts, so they can read in the token's decimals. Amounts stay strings.

import type { DecodedArgDto } from "../api/generated/DecodedArgDto";
import type { TrustDto } from "../api/generated/TrustDto";

/** The ERC-20 token whose amounts a call or event carries; `trust` from the transaction's own transfers of it. */
export type ArgToken = { decimals: number | null; symbol: string | null; trust?: TrustDto };

/** An argument read as an amount of a token; `unlimited` for the uint256 max where it sets an allowance. */
export type ArgAmount = { raw: string; decimals: number; symbol: string | null; unlimited: boolean; trust?: TrustDto };

/** 2^256 - 1, the "unlimited" allowance. */
export const MAX_UINT256 = ((1n << 256n) - 1n).toString();

/**
 * The amount argument of each standard ERC-20 function and event, by canonical signature (functions start lower
 * case, events upper, so one table holds both); `allowance` where it sets an allowance. Other uint256s (a permit's
 * deadline, a mint's amount of who knows what) are never read as amounts.
 */
const AMOUNT_ARG: Record<string, { index: number; allowance: boolean }> = {
  "transfer(address,uint256)": { index: 1, allowance: false },
  "transferFrom(address,address,uint256)": { index: 2, allowance: false },
  "approve(address,uint256)": { index: 1, allowance: true },
  "increaseAllowance(address,uint256)": { index: 1, allowance: false },
  "decreaseAllowance(address,uint256)": { index: 1, allowance: false },
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)": { index: 2, allowance: true },
  "Transfer(address,address,uint256)": { index: 2, allowance: false },
  "Approval(address,address,uint256)": { index: 2, allowance: true },
};

/** `Transfer(address,address,uint256)`: an event's canonical signature from its name and argument types. */
export const eventSignature = (name: string, args: readonly DecodedArgDto[]): string =>
  `${name}(${args.map((a) => a.ty).join(",")})`;

/**
 * Each argument read as an amount of `token`, or null to show it as it is: only the amount argument of a standard
 * ERC-20 signature, and only when the token's decimals are known (no guess otherwise).
 */
export function argAmounts(signature: string, args: readonly DecodedArgDto[], token: ArgToken | undefined): (ArgAmount | null)[] {
  const spec = AMOUNT_ARG[signature];
  return args.map((a, i) => {
    if (!spec || i !== spec.index || !token || token.decimals === null) return null;
    if (a.ty !== "uint256" || !/^\d+$/.test(a.value)) return null;
    const unlimited = spec.allowance && BigInt(a.value) === BigInt(MAX_UINT256);
    return { raw: a.value, decimals: token.decimals, symbol: token.symbol, unlimited, trust: token.trust };
  });
}
