import { parseEther } from "ethers";

export function resolveIntegerInput(
  value: number | undefined,
  fallback: number,
  label: string,
  options: { min?: number } = {},
): number {
  const resolved = value ?? fallback;
  const min = options.min ?? 0;
  if (!Number.isInteger(resolved) || resolved < min) {
    throw new Error(`${label} must be an integer greater than or equal to ${min}`);
  }
  return resolved;
}

export function resolveOptionalIntegerInput(
  value: number | undefined,
  label: string,
  options: { min?: number } = {},
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return resolveIntegerInput(value, value, label, options);
}

export function resolveNonEmptyStringInput(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function resolveEtherInput(value: string | undefined, fallback: string): bigint {
  return parseEther(resolveNonEmptyStringInput(value, fallback));
}
