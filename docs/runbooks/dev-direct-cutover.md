# Development direct cutover (retired)

The full SentryBox cutover is complete. The bundled configuration has forwarding
disabled for both environments and the runtime credential contract requires
exactly `CODE_AGENT_HMAC_DEV,CODE_AGENT_HMAC_PROD`. Do not use this retired
shadow-forwarding procedure or add legacy Sentry credentials.

For current delivery operations, use [Project configuration](project-configuration.md).
