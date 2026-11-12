import { ensure, fail, hex, unhex } from "@hive/kit";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import opcodes from "./emulator-opcodes.json" with { type: "json" };
import { decodeScriptNum, ScriptBuilder } from "./encoding.js";
import { arkadeTweak, taprootOutput, xOnly } from "./taproot.js";

/**
 * Contract artifacts as arkade-os/delegatee reads them, and the derivation of
 * an instance's covenants, leaves and address. It follows the delegatee's
 * `pkg/template` (artifact.go, asm.go, contract.go) token for token, so an
 * address the delegatee reports can be checked against our own derivation;
 * `tools/delegatee-ref` runs the delegatee's code for the tests that compare.
 */
export type ScalarType = "pubkey" | "bytes" | "bytes20" | "bytes32" | "int" | "bool";

export interface Field {
  name: string;
  type: ScalarType;
}

export interface Leaf {
  name: string;
  asm: string[];
  witness?: { name: string; type: string; encoding: string; injected?: boolean }[];
}

export interface ContractFunction {
  name: string;
  arkade?: { inputs: Field[]; asm: string[] };
  leaves: Leaf[];
}

export interface Artifact {
  contractName: string;
  constructorInputs: Field[];
  structs?: [];
  functions: ContractFunction[];
}

/** The service keys a contract is resolved under, compressed. */
export interface ServiceKeys {
  server: string;
  emulator: string;
  delegate: string;
}

export interface Instance {
  /** Arkade Script per function with a covenant. */
  covenants: Record<string, Uint8Array>;
  /** Leaves in function then leaf order, as the delegatee lists them. */
  tapscripts: string[];
  leafNames: [string, string][];
  pkScript: string;
  /** The x-only taproot output key. */
  outputKey: string;
}

const OPCODES = opcodes as Record<string, number>;
const DECIMAL = /^(0|-?[1-9][0-9]*)$/;
const HEX = /^0x([0-9a-f]{2})+$/;
const PLACEHOLDER = /^<([^<>]+)>$/;
const MAX_SCRIPT_NUM = 2n ** 53n - 1n;
const MAX_PUSH = 520;

interface Value {
  type: ScalarType | "bytes32";
  raw: Uint8Array;
}

function opcode(token: string): number {
  const op = OPCODES[token];
  ensure(op !== undefined, "CONTRACT_INVALID", `unknown opcode ${token}`);
  ensure(op === 0 || op > 0x4e, "CONTRACT_INVALID", `push opcode ${token}`);
  return op;
}

function push(builder: ScriptBuilder, token: string, raw: Uint8Array) {
  ensure(raw.length <= MAX_PUSH, "CONTRACT_INVALID", `${token}: push too large`);
  // A lone zero byte stays a one-byte push: the builder would emit OP_0.
  if (raw.length === 1 && raw[0] === 0) builder.addRawPush(raw);
  else builder.addData(raw);
}

/** Assembles tokens exactly as the delegatee's `assemble` does. */
export function assemble(tokens: string[], lookup: (name: string) => Value): Uint8Array {
  const builder = new ScriptBuilder();
  for (const token of tokens) {
    if (token.startsWith("OP_")) builder.addOp(opcode(token));
    else if (DECIMAL.test(token)) {
      const n = BigInt(token);
      ensure(n <= MAX_SCRIPT_NUM && n >= -MAX_SCRIPT_NUM, "CONTRACT_INVALID", `number ${token} out of range`);
      builder.addInt(n);
    } else if (HEX.test(token)) push(builder, token, unhex(token.slice(2)));
    else {
      const name = PLACEHOLDER.exec(token)?.[1];
      ensure(name, "CONTRACT_INVALID", `unsupported token ${token}`);
      const value = lookup(name);
      if (value.type === "int") builder.addInt(decodeScriptNum(value.raw));
      else push(builder, token, value.raw);
    }
  }
  return builder.script();
}

/** Canonical bytes of one constructor or template variable, as its type requires. */
export function encodeValue(type: ScalarType, value: string): Uint8Array {
  const raw = unhex(value);
  switch (type) {
    case "pubkey":
      ensure(raw.length === 33, "CONTRACT_ARGUMENT", "pubkey must be 33 bytes");
      secp256k1.Point.fromHex(value);
      return raw;
    case "bytes32":
      ensure(raw.length === 32, "CONTRACT_ARGUMENT", "bytes32 must be 32 bytes");
      return raw;
    case "bytes20":
      ensure(raw.length === 20, "CONTRACT_ARGUMENT", "bytes20 must be 20 bytes");
      return raw;
    case "int": {
      const n = decodeScriptNum(raw);
      ensure(n <= MAX_SCRIPT_NUM && n >= -MAX_SCRIPT_NUM, "CONTRACT_ARGUMENT", "int out of range");
      return raw;
    }
    case "bool":
      ensure(value === "" || value === "01", "CONTRACT_ARGUMENT", "bool must be empty or 01");
      return raw;
    case "bytes":
      ensure(raw.length <= MAX_PUSH, "CONTRACT_ARGUMENT", "bytes too long");
      return raw;
  }
}

/** Covenants, leaves and address of `artifact` for `args` (hex, by constructor name). */
export function instantiate(artifact: Artifact, args: Record<string, string>, keys: ServiceKeys): Instance {
  const fields = new Map<string, Value>();
  for (const input of artifact.constructorInputs) {
    const value = args[input.name];
    ensure(value !== undefined, "CONTRACT_ARGUMENT", `missing ${input.name}`);
    fields.set(input.name, { type: input.type, raw: encodeValue(input.type, value) });
  }
  ensure(
    Object.keys(args).every((name) => fields.has(name)),
    "CONTRACT_ARGUMENT",
    "unknown constructor argument",
  );
  const field = (name: string): Value => {
    const value = fields.get(name);
    ensure(value, "CONTRACT_INVALID", `unknown constructor value ${name}`);
    return value;
  };
  // Intent messages spell cosigner keys in hex, so covenants do too.
  const covenantLookup = (name: string): Value =>
    name === "DELEGATE_KEY" ? { type: "bytes", raw: new TextEncoder().encode(keys.delegate) } : field(name);

  const covenants: Record<string, Uint8Array> = {};
  for (const fn of artifact.functions)
    if (fn.arkade) covenants[fn.name] = assemble(fn.arkade.asm, covenantLookup);

  const tweak = (key: string, fn: string): Value => {
    const covenant = covenants[fn];
    ensure(covenant, "CONTRACT_INVALID", `function ${fn} has no covenant`);
    return { type: "bytes32", raw: arkadeTweak(key, covenant) };
  };
  const leafLookup = (name: string): Value => {
    const parts = name.split(":");
    if (name === "SERVER_KEY") return { type: "bytes32", raw: xOnly(keys.server) };
    if (name === "DELEGATE_KEY") return { type: "bytes32", raw: xOnly(keys.delegate) };
    if (parts.length === 2 && parts[0] === "EMULATOR_KEY") return tweak(keys.emulator, parts[1]!);
    if (parts.length === 3 && parts[0] === "TWEAK") return tweak(hex(field(parts[1]!).raw), parts[2]!);
    ensure(parts.length === 1, "CONTRACT_INVALID", `unsupported placeholder ${name}`);
    const value = field(name);
    return value.type === "pubkey" ? { type: "bytes32", raw: xOnly(hex(value.raw)) } : value;
  };

  const tapscripts: string[] = [];
  const leafNames: [string, string][] = [];
  for (const fn of artifact.functions)
    for (const leaf of fn.leaves) {
      const script = hex(assemble(leaf.asm, leafLookup));
      ensure(!tapscripts.includes(script), "CONTRACT_INVALID", `duplicate leaf ${fn.name}/${leaf.name}`);
      tapscripts.push(script);
      leafNames.push([fn.name, leaf.name]);
    }
  ensure(tapscripts.length > 0, "CONTRACT_INVALID", "no leaves");
  const output = taprootOutput(tapscripts.map(unhex));
  return { covenants, tapscripts, leafNames, pkScript: `5120${hex(output)}`, outputKey: hex(output) };
}

/** The leaf script of one function's leaf. */
export function leafOf(instance: Instance, fn: string, leaf = fn): string {
  const at = instance.leafNames.findIndex(([f, l]) => f === fn && l === leaf);
  if (at < 0) fail("CONTRACT_INVALID", `no leaf ${fn}/${leaf}`);
  return instance.tapscripts[at]!;
}
