const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function hmacSha256(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function unsafeParsePayload<T>(encoded: string): T | null {
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
    );
    return JSON.parse(json) as T;
  } catch { return null; }
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

export function equalSecret(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Fever mandates MD5(username:password). Do not use this for any other secret. */
export function md5(value: string): string {
  const input = new TextEncoder().encode(value);
  const length = (((input.length + 8) >>> 6) + 1) * 16;
  const words = new Uint32Array(length);
  for (let i = 0; i < input.length; i++) { const index=i>>>2; words[index]=(words[index] ?? 0) | (input[i]! << ((i%4)*8)); }
  const end=input.length>>>2; words[end]=(words[end] ?? 0) | (0x80 << ((input.length%4)*8));
  words[length - 2] = input.length * 8;
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  for (let offset=0; offset<words.length; offset+=16) {
    let a=a0,b=b0,c=c0,d=d0;
    for (let i=0;i<64;i++) {
      let f=0,g=0,s=0;
      if(i<16){f=(b&c)|(~b&d);g=i;s=shifts[i%4]!;}
      else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;s=shifts[4+i%4]!;}
      else if(i<48){f=b^c^d;g=(3*i+5)%16;s=shifts[8+i%4]!;}
      else{f=c^(b|~d);g=(7*i)%16;s=shifts[12+i%4]!;}
      const sum=(a+f+constants[i]!+words[offset+g]!)>>>0;
      a=d;d=c;c=b;b=(b+((sum<<s)|(sum>>>(32-s))))>>>0;
    }
    a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;
  }
  return [a0,b0,c0,d0].map(word => [0,8,16,24].map(shift => ((word>>>shift)&255).toString(16).padStart(2,'0')).join('')).join('');
}
