import { readFileSync, statSync } from "node:fs";

export interface SecretStore {
  resolve(reference: string): string;
  references(): readonly string[];
}

export interface LoadSecretStoreOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly requiredReferences: readonly string[];
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;

export function loadSecretStore(options: LoadSecretStoreOptions): SecretStore {
  const environment = options.environment ?? process.env;
  const path = environment.ERROR_HUB_ENV_FILE?.trim();
  if (path === undefined || path.length === 0) {
    throw new Error("ERROR_HUB_ENV_FILE must be configured");
  }
  const required = validatedReferences(options.requiredReferences);
  const status = statSync(path);
  if (!status.isFile()) {
    throw new Error("ERROR_HUB_ENV_FILE must reference a regular file");
  }
  if ((status.mode & 0o077) !== 0) {
    throw new Error(
      "ERROR_HUB_ENV_FILE permissions must not allow group or world access",
    );
  }
  const values = parseCredentialFile(readFileSync(path, "utf8"));
  for (const reference of required) {
    if (!values.has(reference)) {
      throw new Error(`required credential reference is missing: ${reference}`);
    }
  }
  for (const name of values.keys()) {
    if (!required.has(name)) {
      throw new Error(`unreferenced credential entry: ${name}`);
    }
  }
  return new LoadedSecretStore(values, [...required].sort(compareCodePoints));
}

class LoadedSecretStore implements SecretStore {
  readonly #values: ReadonlyMap<string, string>;
  readonly #references: readonly string[];

  public constructor(
    values: ReadonlyMap<string, string>,
    references: readonly string[],
  ) {
    this.#values = new Map(values);
    this.#references = Object.freeze([...references]);
    Object.freeze(this);
  }

  public resolve(reference: string): string {
    const value = this.#values.get(reference);
    if (value === undefined) {
      throw new Error(`credential reference is not configured: ${reference}`);
    }
    return value;
  }

  public references(): readonly string[] {
    return this.#references;
  }

  public toJSON(): { readonly references: readonly string[] } {
    return { references: this.#references };
  }
}

function parseCredentialFile(contents: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) {
      throw new Error(
        `credential file line ${String(index + 1)} must use KEY=VALUE`,
      );
    }
    const name = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!SECRET_NAME.test(name)) {
      throw new Error(
        `credential file line ${String(index + 1)} has an invalid key`,
      );
    }
    if (values.has(name)) {
      throw new Error(`duplicate credential entry: ${name}`);
    }
    if (value.length === 0) {
      throw new Error(`credential entry is empty: ${name}`);
    }
    values.set(name, value);
  }
  return values;
}

function validatedReferences(references: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const reference of references) {
    if (!SECRET_NAME.test(reference)) {
      throw new Error(`invalid credential reference: ${reference}`);
    }
    if (result.has(reference)) {
      throw new Error(`duplicate required credential reference: ${reference}`);
    }
    result.add(reference);
  }
  return result;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
