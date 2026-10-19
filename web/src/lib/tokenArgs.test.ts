import type { DecodedArgDto } from "../api/generated/DecodedArgDto";
import { argAmounts, eventSignature, MAX_UINT256 } from "./tokenArgs";

const TO = "0xae39efdbb5d8a50e7031b6f9f957d43cdfbae72b";
const USDC = { decimals: 6, symbol: "USDC" };
const arg = (name: string, ty: string, value: string): DecodedArgDto => ({ name, ty, value });

test("the amount of a transfer reads in the token's decimals; the address stays as it is", () => {
  const args = [arg("to", "address", TO), arg("value", "uint256", "4699465952")];
  expect(argAmounts("transfer(address,uint256)", args, USDC)).toEqual([
    null,
    { raw: "4699465952", decimals: 6, symbol: "USDC", unlimited: false, trust: undefined },
  ]);
});

test("transferFrom, the allowance functions and permit name their amount argument", () => {
  const two = [arg("a", "address", TO), arg("v", "uint256", "5")];
  const at = (sig: string, args: DecodedArgDto[]) => argAmounts(sig, args, USDC).findIndex((m) => m !== null);
  expect(at("transferFrom(address,address,uint256)", [arg("f", "address", TO), ...two])).toBe(2);
  expect(at("increaseAllowance(address,uint256)", two)).toBe(1);
  expect(at("decreaseAllowance(address,uint256)", two)).toBe(1);
  const permit = [
    arg("owner", "address", TO), arg("spender", "address", TO), arg("value", "uint256", "5"),
    arg("deadline", "uint256", "1709382600"), arg("v", "uint8", "27"), arg("r", "bytes32", "0x00"), arg("s", "bytes32", "0x00"),
  ];
  // The value, never the deadline.
  expect(argAmounts("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", permit, USDC).map((m) => m?.raw ?? null))
    .toEqual([null, null, "5", null, null, null, null]);
});

test("the uint256 max reads as unlimited only where it sets an allowance", () => {
  const max = [arg("spender", "address", TO), arg("value", "uint256", MAX_UINT256)];
  expect(MAX_UINT256).toHaveLength(78);
  expect(argAmounts("approve(address,uint256)", max, USDC)[1]?.unlimited).toBe(true);
  expect(argAmounts("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", [
    arg("o", "address", TO), ...max, arg("d", "uint256", "1"), arg("v", "uint8", "27"), arg("r", "bytes32", "0x"), arg("s", "bytes32", "0x"),
  ], USDC)[2]?.unlimited).toBe(true);
  expect(argAmounts("Approval(address,address,uint256)", [arg("owner", "address", TO), ...max], USDC)[2]?.unlimited).toBe(true);
  expect(argAmounts("transfer(address,uint256)", max, USDC)[1]?.unlimited).toBe(false);
  expect(argAmounts("approve(address,uint256)", [max[0]!, arg("value", "uint256", "1000")], USDC)[1]?.unlimited).toBe(false);
});

test("events count their amount by their own signature", () => {
  const args = [arg("from", "address", TO), arg("to", "address", TO), arg("value", "uint256", "7")];
  expect(eventSignature("Transfer", args)).toBe("Transfer(address,address,uint256)");
  expect(argAmounts(eventSignature("Transfer", args), args, USDC)[2]?.raw).toBe("7");
});

test("unknown decimals, no token, or a non-standard signature leave every argument raw", () => {
  const args = [arg("to", "address", TO), arg("value", "uint256", "4699465952")];
  expect(argAmounts("transfer(address,uint256)", args, { decimals: null, symbol: "USDC" })).toEqual([null, null]);
  expect(argAmounts("transfer(address,uint256)", args, undefined)).toEqual([null, null]);
  expect(argAmounts("deposit(address,uint256)", args, USDC)).toEqual([null, null]);
  expect(argAmounts("mint(uint256)", [arg("amount", "uint256", "5")], USDC)).toEqual([null]);
});
