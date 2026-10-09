import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
export type Identity =
  | { kind: "bearer"; token: string }
  | { kind: "broker"; principal: string; account: string }
  | { kind: "none" };
export function requestIdentity(
  req: Pick<Request, "headers">,
  hmacKey = process.env.BROKER_PRINCIPAL_HMAC_KEY ?? "",
): Identity {
  const header = (name: string) => {
    const value = req.headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const auth = header("authorization");
  if (auth) {
    const match = /^Bearer ([^\s]+)$/i.exec(auth);
    if (!match)
      throw new Error(
        "Authorization must be Bearer plus a Google OAuth access token",
      );
    return { kind: "bearer", token: match[1] };
  }
  const account = header("x-broker-account") ?? "";
  if (!/^[A-Za-z0-9_.-]{0,100}$/.test(account))
    throw new Error("Invalid broker account label");
  const principal = header("x-broker-principal");
  if (principal) {
    if (principal.length > 512 || !principal.trim() || /[\r\n]/.test(principal))
      throw new Error("Invalid principal");
    if (hmacKey) {
      const signature = header("x-broker-principal-sig") ?? "";
      const expected = createHmac("sha256", hmacKey)
        .update(principal)
        .digest("base64url");
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        throw new Error("Invalid principal signature");
    }
    return { kind: "broker", principal, account };
  }
  const callerKey = header("x-mcp-caller-key");
  if (callerKey) {
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(callerKey))
      throw new Error(
        "X-MCP-Caller-Key must be a private random 32-byte base64url value",
      );
    return {
      kind: "broker",
      principal: `external:${createHash("sha256").update(callerKey).digest("hex")}`,
      account,
    };
  }
  return { kind: "none" };
}
