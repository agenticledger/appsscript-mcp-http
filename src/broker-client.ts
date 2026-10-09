import jwt from "jsonwebtoken";
import { ApiError } from "./api-client.js";
export const brokerBaseUrl = (
  process.env.BROKER_BASE_URL ?? "https://connectionsbroker.agenticledger.ai"
).replace(/\/$/, "");
export const brokerClientNamespace = process.env.BROKER_CLIENT_NAMESPACE ?? "";
export const brokerProvider = "google-appsscript";
const bearer = process.env.BROKER_INSTALL_BEARER ?? "";
const key = process.env.BROKER_JWT_KEY ?? "";
export const brokerConfigured = !!(bearer && key && brokerClientNamespace);
if (!brokerBaseUrl.startsWith("https://"))
  throw new Error("Broker requires HTTPS");
async function broker(
  path: string,
  principal: string,
  account: string,
): Promise<Response> {
  try {
    return await fetch(brokerBaseUrl + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Broker-Token": jwt.sign(
          { clientNamespace: brokerClientNamespace, principal },
          key,
          { algorithm: "HS256", expiresIn: "60s" },
        ),
      },
      body: JSON.stringify({
        provider: brokerProvider,
        ...(account ? { account } : {}),
      }),
    });
  } catch {
    throw new ApiError(
      "broker_unavailable",
      "Connections Broker is unavailable; retry later",
    );
  }
}
export async function resolveCredential(
  principal: string,
  account = "",
): Promise<
  | string
  | { status: string; provider: string; connectUrl: string; message: string }
> {
  if (!brokerConfigured)
    throw new ApiError(
      "broker_unconfigured",
      "Broker install identity is not configured",
    );
  const response = await broker("/token", principal, account);
  if (response.status === 404) {
    const consent = await broker("/connect", principal, account);
    if (!consent.ok)
      throw new ApiError(
        "broker_connect_failed",
        `Broker consent request returned HTTP ${consent.status}`,
      );
    const data = (await consent.json()) as { authorizeUrl?: string };
    if (!data.authorizeUrl?.startsWith("https://"))
      throw new ApiError(
        "broker_invalid_response",
        "Broker returned no valid consent URL",
      );
    return {
      status: "connection_required",
      provider: brokerProvider,
      connectUrl: data.authorizeUrl,
      message:
        "Connect Google Apps Script using this one-time link, then retry with the same caller identity and account. Enable the Apps Script API in your Google user settings first.",
    };
  }
  if (!response.ok)
    throw new ApiError(
      "broker_error",
      `Broker credential request returned HTTP ${response.status}`,
    );
  const data = (await response.json()) as { accessToken?: string };
  if (!data.accessToken)
    throw new ApiError(
      "broker_invalid_response",
      "Broker returned no credential",
    );
  return data.accessToken;
}
