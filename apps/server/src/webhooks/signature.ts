import { createHmac } from "node:crypto";

export function signWebhookBody(body: Uint8Array, secret: string): string {
  if (body.byteLength === 0) {
    throw new TypeError("webhook body must not be empty");
  }
  if (secret.length === 0) {
    throw new TypeError("webhook secret must not be empty");
  }
  return createHmac("sha256", secret).update(body).digest("hex");
}
