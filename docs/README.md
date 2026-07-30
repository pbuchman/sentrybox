# SentryBox documentation

This index separates the stable product contract from compatibility reference,
the current example deployment, and historical implementation records.

## Product

- [Product overview](../README.md) — the problem SentryBox addresses, the
  operating model, current status, and development entry points.
- [Product and architecture contract](specification.md) — the stable,
  deployment-neutral scope, data model, behavior, and acceptance invariants.

## Reference

- [Normative Sentry compatibility](reference/sentry-compatibility.md) — tested
  SDK and protocol coverage, explicit unsupported capabilities, fidelity gaps,
  API and MCP limits, and storage semantics.

## Example deployment and operations

IntexuraOS on Home Dev is the current reference deployment. These runbooks
describe that concrete installation; they are not requirements for every
SentryBox deployment.

- [Project configuration](runbooks/project-configuration.md)
- [Network exposure](runbooks/network-exposure.md)
- [Operations and monitoring](runbooks/operations.md)
- [Backup and recovery](runbooks/backup-and-recovery.md)
- [Credential rotation](runbooks/credential-rotation.md)
- [Automation acceptance](runbooks/automation-acceptance.md)

## Historical

These records explain completed design and implementation decisions. They are
retained for context and are not current work queues or operating procedures.

- [Documentation redesign decision](archive/design/2026-07-30-documentation-redesign.md)
- [Documentation redesign implementation record](archive/implementation-plans/2026-07-30-documentation-redesign.md)
- [Core implementation plan](superpowers/plans/2026-07-28-error-hub-core-implementation.md)
- [Home Dev deployment and cutover plan](superpowers/plans/2026-07-28-home-dev-deployment-and-cutover.md)
- [IntexuraOS integration plan](superpowers/plans/2026-07-28-intexuraos-integration.md)
- [SentryBox rename plan](superpowers/plans/2026-07-29-sentrybox-rename.md)
- [Retired development cutover procedure](runbooks/dev-direct-cutover.md)
