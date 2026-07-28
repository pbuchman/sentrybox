import { createGunzip } from "node:zlib";

import {
  DEFAULT_MAX_DECOMPRESSION_RATIO,
  EnvelopeProtocolError,
  MAX_DECOMPRESSED_ENVELOPE_BYTES,
} from "./sentry-types.js";

export async function decompressEnvelope(
  input: NodeJS.ReadableStream,
  encoding: string | undefined,
): Promise<Uint8Array> {
  const normalizedEncoding = encoding?.trim().toLowerCase();

  if (
    normalizedEncoding === undefined ||
    normalizedEncoding === "" ||
    normalizedEncoding === "identity"
  ) {
    return collectBody(input);
  }
  if (normalizedEncoding !== "gzip") {
    throw new EnvelopeProtocolError(
      "UNSUPPORTED_CONTENT_ENCODING",
      `Unsupported Content-Encoding: ${encoding}.`,
    );
  }

  return collectGzipBody(input);
}

async function collectGzipBody(
  input: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const gunzip = createGunzip();
  let compressedBytes = 0;
  const countCompressedBytes = (chunk: Uint8Array | string): void => {
    compressedBytes +=
      typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
  };
  input.on("data", countCompressedBytes);
  const output = input.pipe(gunzip);
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;

  try {
    for await (const chunk of output) {
      const bytes = toUint8Array(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_DECOMPRESSED_ENVELOPE_BYTES) {
        throw new EnvelopeProtocolError(
          "DECOMPRESSED_BODY_TOO_LARGE",
          "Decompressed envelope body exceeds 1 MiB.",
        );
      }
      if (
        compressedBytes > 0 &&
        outputBytes > compressedBytes * DEFAULT_MAX_DECOMPRESSION_RATIO
      ) {
        throw new EnvelopeProtocolError(
          "DECOMPRESSION_RATIO_EXCEEDED",
          "Decompressed envelope body exceeds the allowed compression ratio.",
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    input.unpipe(gunzip);
    gunzip.destroy();
    if (error instanceof EnvelopeProtocolError) {
      throw error;
    }
    throw new EnvelopeProtocolError(
      "INVALID_GZIP",
      "Could not decompress gzip request body.",
      {
        cause: error,
      },
    );
  } finally {
    input.off("data", countCompressedBytes);
  }

  return concatenate(chunks, outputBytes);
}

async function collectBody(input: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  try {
    for await (const chunk of input) {
      const bytes = toUint8Array(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > MAX_DECOMPRESSED_ENVELOPE_BYTES) {
        throw new EnvelopeProtocolError(
          "DECOMPRESSED_BODY_TOO_LARGE",
          "Envelope body exceeds 1 MiB.",
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof EnvelopeProtocolError) {
      throw error;
    }
    throw error;
  }
  return concatenate(chunks, outputBytes);
}

function toUint8Array(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
}

function concatenate(
  chunks: readonly Uint8Array[],
  length: number,
): Uint8Array {
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
