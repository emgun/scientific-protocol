import { createHash } from "node:crypto";

export type HashableContent = string | Uint8Array;

export function sha256Hex(content: HashableContent): string {
  return createHash("sha256").update(content).digest("hex");
}
