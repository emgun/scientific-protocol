import { keccak256, toUtf8Bytes } from "ethers";

export function keccakText(value: string): string {
  return keccak256(toUtf8Bytes(value));
}
