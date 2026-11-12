// Decode a JWT's payload without verifying it; null when the token is not a JWT.
export function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString()); } catch { return null; }
}

// A JWT's exp claim in epoch seconds; 0 when absent or not a JWT.
export const jwtExp = (token) => jwtPayload(token)?.exp || 0;
