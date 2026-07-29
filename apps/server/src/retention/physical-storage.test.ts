import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPhysicalStorageSampler,
  nodePhysicalStorageFs,
} from "./physical-storage.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("physical storage sampler", () => {
  it("accounts DB, WAL, SHM, explicit temp, bounded other files, and injected filesystem free bytes once", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    const temporaryPath = join(directory, "sqlite-temp-1");
    writeBytes(databasePath, 10);
    writeBytes(`${databasePath}-wal`, 20);
    writeBytes(`${databasePath}-shm`, 30);
    writeBytes(temporaryPath, 40);
    writeBytes(join(directory, "other.bin"), 50);
    const sampler = createPhysicalStorageSampler({
      dataDirectory: directory,
      databasePath,
      temporaryPaths: [temporaryPath],
      maxDirectoryEntries: 8,
      fs: {
        ...nodePhysicalStorageFs,
        async statfs() {
          return { blockSize: 4_096, availableBlocks: 100 };
        },
      },
    });

    await expect(sampler()).resolves.toEqual({
      databaseBytes: 10,
      walBytes: 20,
      shmBytes: 30,
      temporaryBytes: 40,
      dataDirectoryOtherBytes: 50,
      totalBytes: 150,
      freeBytes: 409_600,
    });
  });

  it("rejects explicit path escape and duplicate accounting before sampling", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    expect(() =>
      createPhysicalStorageSampler({
        dataDirectory: directory,
        databasePath,
        temporaryPaths: [databasePath],
        maxDirectoryEntries: 8,
      }),
    ).toThrow(/duplicate|overlap/u);
    expect(() =>
      createPhysicalStorageSampler({
        dataDirectory: directory,
        databasePath,
        temporaryPaths: [join(directory, "..", "escaped.tmp")],
        maxDirectoryEntries: 8,
      }),
    ).toThrow(/inside the data directory/u);
  });

  it("rejects symlinks and duplicate hard-link identities instead of double counting", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    writeBytes(databasePath, 10);
    symlinkSync(databasePath, join(directory, "linked.sqlite"));
    const symlinkSampler = createPhysicalStorageSampler({
      dataDirectory: directory,
      databasePath,
      temporaryPaths: [],
      maxDirectoryEntries: 8,
    });
    await expect(symlinkSampler()).rejects.toThrow(/symbolic link/u);

    rmSync(join(directory, "linked.sqlite"));
    linkSync(databasePath, join(directory, "hard-linked.sqlite"));
    const hardLinkSampler = createPhysicalStorageSampler({
      dataDirectory: directory,
      databasePath,
      temporaryPaths: [],
      maxDirectoryEntries: 8,
    });
    await expect(hardLinkSampler()).rejects.toThrow(
      /file identity|double count/u,
    );
  });

  it("fails closed on an unbounded top-level scan or nested directory", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    writeBytes(databasePath, 10);
    writeBytes(join(directory, "one"), 1);
    writeBytes(join(directory, "two"), 1);
    const bounded = createPhysicalStorageSampler({
      dataDirectory: directory,
      databasePath,
      temporaryPaths: [],
      maxDirectoryEntries: 2,
    });
    await expect(bounded()).rejects.toThrow(/entry limit/u);

    rmSync(join(directory, "two"));
    mkdirSync(join(directory, "nested"));
    const nested = createPhysicalStorageSampler({
      dataDirectory: directory,
      databasePath,
      temporaryPaths: [],
      maxDirectoryEntries: 8,
    });
    await expect(nested()).rejects.toThrow(/nested director/u);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-physical-"));
  directories.push(directory);
  return directory;
}

function writeBytes(path: string, bytes: number): void {
  writeFileSync(path, Buffer.alloc(bytes, 1));
}
