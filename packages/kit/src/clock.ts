export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function unixNow(): string {
  return nowSeconds().toString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
