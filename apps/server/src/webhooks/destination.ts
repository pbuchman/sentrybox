import type { SecretStore } from "../secrets.js";

export interface ValidatedWebhookDestination {
  readonly targetUrl: string;
  readonly secretRef: string;
}

export function validateWebhookDestination(
  targetUrl: string,
  secretRef: string,
  secrets: Pick<SecretStore, "references">,
): ValidatedWebhookDestination {
  const canonicalTarget = canonicalWebhookTargetUrl(targetUrl);
  if (!secrets.references().includes(secretRef)) {
    throw new TypeError("webhook secret reference is not configured");
  }
  return { targetUrl: canonicalTarget, secretRef };
}

export function canonicalWebhookTargetUrl(targetUrl: string): string {
  const target = new URL(targetUrl);
  if (
    target.protocol !== "https:" ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.pathname !== "/api/code/webhooks/sentry" ||
    target.search.length > 0 ||
    target.hash.length > 0
  ) {
    throw new TypeError(
      "webhook target must be a canonical HTTPS Code Agent endpoint",
    );
  }
  return target.toString();
}
