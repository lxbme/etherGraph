// Call-trace fixtures for the call-tree tests: the recorded ENS registration and synthetic frames.
import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import ens from "../../../../crates/eg-blockscout/tests/data/ens_register.json";

type Raw = {
  action: { callType?: string; from: string; to?: string; gas: string; input: string; value?: string };
  result?: { gasUsed: string; output: string };
  error?: string;
  traceAddress: number[];
  type: string;
};

const KINDS: Record<string, CallFrameDto["kind"]> = {
  call: "call", staticcall: "staticcall", delegatecall: "delegatecall", callcode: "callcode",
  create: "create", create2: "create2", suicide: "selfdestruct",
};

/** A raw Blockscout frame as the API serves it, undecoded. */
function frameOf(r: Raw): CallFrameDto {
  const a = r.action;
  return {
    path: r.traceAddress,
    kind: KINDS[a.callType ?? r.type]!,
    from: a.from,
    to: a.to ?? null,
    value: BigInt(a.value ?? "0x0").toString(),
    input: a.input,
    output: r.result?.output ?? null,
    gas: Number(BigInt(a.gas)),
    gas_used: r.result ? Number(BigInt(r.result.gasUsed)) : null,
    error: r.error ?? null,
    call: null,
    revert: null,
    via_delegate: null,
    via_delegate_current: false,
  };
}

/** The 17 frames of ENS registration 0x461e68…45a3 (STATICCALLs, a self-DELEGATECALL, callbacks to the sender). */
export const ensFrames = (ens as Raw[]).map(frameOf);
export const SENDER = "0x82eb45562f991329ed2867f43fc60f0ba52c3dab";

export const A = "0x" + "aa".repeat(20);
export const B = "0x" + "bb".repeat(20);
export const X = "0x" + "cc".repeat(20);

export const synth = (path: number[], over: Partial<CallFrameDto> = {}): CallFrameDto => ({
  path, kind: "call", from: A, to: B, value: "0", input: "0x", output: "0x", gas: 1, gas_used: 1,
  error: null, call: null, revert: null, via_delegate: null, via_delegate_current: false, ...over,
});
