#!/usr/bin/env node

const [imageReference, commitSha, manifestDigest, ...unexpected] =
  process.argv.slice(2);

try {
  if (
    unexpected.length > 0 ||
    imageReference === undefined ||
    commitSha === undefined
  ) {
    throw new Error(
      "expected <image-reference> <commit-sha> [manifest-digest]",
    );
  }

  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error(
      "commit SHA must contain exactly 40 lowercase hexadecimal characters",
    );
  }

  const match = /^ghcr\.io\/pbuchman\/sentrybox:sha-([0-9a-f]{40})$/u.exec(
    imageReference,
  );
  if (match === null) {
    throw new Error("image reference is not the immutable SentryBox SHA tag");
  }
  if (match[1] !== commitSha) {
    throw new Error("image reference does not match the tested commit SHA");
  }

  if (
    manifestDigest !== undefined &&
    !/^sha256:[0-9a-f]{64}$/u.test(manifestDigest)
  ) {
    throw new Error("manifest digest must be a complete sha256 digest");
  }

  process.stdout.write(
    `Verified immutable image ${imageReference}${manifestDigest === undefined ? "" : `@${manifestDigest}`}\n`,
  );
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown validation error";
  process.stderr.write(`Invalid SentryBox image reference: ${message}\n`);
  process.exitCode = 1;
}
