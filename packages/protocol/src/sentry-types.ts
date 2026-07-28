export interface EnvelopeItem {
  readonly type: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly payload: Uint8Array;
}

export interface ParsedEnvelope {
  readonly eventId: string | null;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly items: readonly EnvelopeItem[];
}

export const MAX_DECOMPRESSED_ENVELOPE_BYTES = 1_048_576;
export const DEFAULT_MAX_DECOMPRESSION_RATIO = 100;

export const DEFAULT_DECOMPRESSION_LIMITS = {
  maxOutputBytes: MAX_DECOMPRESSED_ENVELOPE_BYTES,
  maxCompressionRatio: DEFAULT_MAX_DECOMPRESSION_RATIO,
} as const;

export interface DecompressionLimits {
  readonly maxOutputBytes: number;
  readonly maxCompressionRatio: number;
}

export type DecompressionLimitOverrides = Readonly<
  Partial<DecompressionLimits>
>;

export type EnvelopeProtocolErrorCode =
  | "AMBIGUOUS_PAYLOAD_FRAMING"
  | "DECOMPRESSED_BODY_TOO_LARGE"
  | "DECOMPRESSION_RATIO_EXCEEDED"
  | "DUPLICATE_HEADER_FIELD"
  | "INVALID_DECOMPRESSION_LIMITS"
  | "INVALID_ENVELOPE_HEADER"
  | "INVALID_GZIP"
  | "INVALID_ITEM_HEADER"
  | "MALFORMED_JSON"
  | "TRUNCATED_ITEM"
  | "TRUNCATED_PAYLOAD"
  | "UNSUPPORTED_CONTENT_ENCODING";

export class EnvelopeProtocolError extends Error {
  public readonly name = "EnvelopeProtocolError";

  public constructor(
    public readonly code: EnvelopeProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
