export const MAX_TITLE_BYTES = 4 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024;
export const MAX_EXCEPTION_FRAMES = 200;
export const MAX_BREADCRUMBS = 100;
export const MAX_TAGS = 100;
export const MAX_TAG_KEY_BYTES = 200;
export const MAX_TAG_VALUE_BYTES = 1024;
export const MAX_NORMALIZED_EVENT_BYTES = 512 * 1024;
export const MAX_RECURSION_DEPTH = 8;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}
