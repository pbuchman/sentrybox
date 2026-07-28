import * as nodeFs from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { PhysicalStorageUsage } from "./storage-budget.js";

interface FileEntry {
  readonly size: number | bigint;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface PhysicalStorageFs {
  lstat(path: string): Promise<FileEntry | null>;
  readdir(path: string, maxEntries: number): Promise<readonly string[]>;
  realpath(path: string): Promise<string>;
  statfs(path: string): Promise<{
    readonly blockSize: number | bigint;
    readonly availableBlocks: number | bigint;
  }>;
}

export const nodePhysicalStorageFs: PhysicalStorageFs = {
  async lstat(path) {
    try {
      return await nodeFs.lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  },
  async readdir(path, maxEntries) {
    const names: string[] = [];
    const directory = await nodeFs.opendir(path);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > maxEntries) {
        throw new Error("physical storage directory entry limit exceeded");
      }
    }
    return names;
  },
  realpath: (path) => nodeFs.realpath(path),
  async statfs(path) {
    const result = await nodeFs.statfs(path, { bigint: true });
    return { blockSize: result.bsize, availableBlocks: result.bavail };
  },
};

export interface PhysicalStorageSamplerOptions {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly temporaryPaths?: readonly string[];
  readonly maxDirectoryEntries: number;
  readonly fs?: PhysicalStorageFs;
}

export function createPhysicalStorageSampler(
  options: PhysicalStorageSamplerOptions,
): () => Promise<PhysicalStorageUsage> {
  const dataDirectory = explicitAbsolutePath(
    options.dataDirectory,
    "data directory",
  );
  const databasePath = directChild(
    dataDirectory,
    options.databasePath,
    "database path",
  );
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  const temporaryPaths = (options.temporaryPaths ?? []).map((path, index) =>
    directChild(dataDirectory, path, `temporary path ${String(index)}`),
  );
  const explicitPaths = [databasePath, walPath, shmPath, ...temporaryPaths];
  if (new Set(explicitPaths).size !== explicitPaths.length) {
    throw new TypeError("physical storage paths must not overlap");
  }
  if (
    !Number.isSafeInteger(options.maxDirectoryEntries) ||
    options.maxDirectoryEntries <= 0
  ) {
    throw new TypeError(
      "max directory entries must be a positive safe integer",
    );
  }
  const fs = options.fs ?? nodePhysicalStorageFs;
  const temporarySet = new Set(temporaryPaths);

  return async () => {
    const directoryEntry = await fs.lstat(dataDirectory);
    if (
      directoryEntry === null ||
      directoryEntry.isSymbolicLink() ||
      !directoryEntry.isDirectory()
    ) {
      throw new Error(
        "physical storage data directory must be a real directory",
      );
    }
    const names = await fs.readdir(dataDirectory, options.maxDirectoryEntries);
    if (names.length > options.maxDirectoryEntries) {
      throw new Error("physical storage directory entry limit exceeded");
    }
    const realDataDirectory = normalize(await fs.realpath(dataDirectory));
    const identity = new Set<string>();
    const realPaths = new Set<string>();
    let databaseBytes = 0;
    let walBytes = 0;
    let shmBytes = 0;
    let temporaryBytes = 0;
    let dataDirectoryOtherBytes = 0;

    for (const name of names) {
      if (
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        /[/\\]/u.test(name)
      ) {
        throw new Error("physical storage directory returned an invalid entry");
      }
      const path = join(dataDirectory, name);
      const entry = await fs.lstat(path);
      if (entry === null) continue;
      if (entry.isSymbolicLink()) {
        throw new Error("physical storage directory contains a symbolic link");
      }
      if (!entry.isFile()) {
        throw new Error(
          "physical storage directory contains a nested directory",
        );
      }
      const realPath = normalize(await fs.realpath(path));
      if (dirname(realPath) !== realDataDirectory) {
        throw new Error(
          "physical storage file resolves outside the data directory",
        );
      }
      const inode = `${String(entry.dev)}:${String(entry.ino)}`;
      if (identity.has(inode) || realPaths.has(realPath)) {
        throw new Error(
          "physical storage file identity would be double counted",
        );
      }
      identity.add(inode);
      realPaths.add(realPath);
      const size = safeNonNegativeNumber(
        entry.size,
        "physical storage file size",
      );
      if (path === databasePath) databaseBytes += size;
      else if (path === walPath) walBytes += size;
      else if (path === shmPath) shmBytes += size;
      else if (temporarySet.has(path)) temporaryBytes += size;
      else dataDirectoryOtherBytes += size;
    }
    const statfs = await fs.statfs(dataDirectory);
    const freeBytes = safeProduct(
      statfs.blockSize,
      statfs.availableBlocks,
      "filesystem free bytes",
    );
    const totalBytes = safeSum([
      databaseBytes,
      walBytes,
      shmBytes,
      temporaryBytes,
      dataDirectoryOtherBytes,
    ]);
    return {
      databaseBytes,
      walBytes,
      shmBytes,
      temporaryBytes,
      dataDirectoryOtherBytes,
      totalBytes,
      freeBytes,
    };
  };
}

function explicitAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path)) throw new TypeError(`${field} must be absolute`);
  return resolve(path);
}

function directChild(parent: string, path: string, field: string): string {
  const child = explicitAbsolutePath(path, field);
  if (dirname(child) !== parent) {
    throw new TypeError(
      `${field} must be inside the data directory as a direct child`,
    );
  }
  return child;
}

function safeNonNegativeNumber(value: number | bigint, field: string): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return result;
}

function safeProduct(
  left: number | bigint,
  right: number | bigint,
  field: string,
): number {
  const result = BigInt(left) * BigInt(right);
  return safeNonNegativeNumber(result, field);
}

function safeSum(values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return safeNonNegativeNumber(result, "physical storage total bytes");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
