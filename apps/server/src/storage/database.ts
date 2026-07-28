import Database from "better-sqlite3";

export type ErrorHubDatabase = Database.Database;

const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;

/** Opens one configured Error Hub SQLite connection. */
export function openDatabase(filename: string): ErrorHubDatabase {
  if (filename.trim().length === 0) {
    throw new TypeError("database filename must not be empty");
  }

  const database = new Database(filename);
  try {
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.pragma("foreign_keys = ON");
    database.pragma("auto_vacuum = INCREMENTAL");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
