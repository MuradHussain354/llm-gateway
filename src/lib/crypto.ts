export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): { key: string; prefix: string } {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(rawBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `gw_${hex}`;
  const prefix = key.slice(0, 8);
  return { key, prefix };
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashABuffer = await crypto.subtle.digest("SHA-256", encoder.encode(a));
  const hashBBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(b));
  const hashA = new Uint8Array(hashABuffer);
  const hashB = new Uint8Array(hashBBuffer);

  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}
