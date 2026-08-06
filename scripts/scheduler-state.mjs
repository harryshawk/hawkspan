import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function openLockDatabase(filePath) {
  const database = new DatabaseSync(`${filePath}.lock.sqlite3`);
  const waitMs = Math.max(
    1000,
    Number(process.env.HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS || 30000),
  );
  database.exec(`PRAGMA busy_timeout = ${Math.floor(waitMs)}`);
  database.exec("CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1))");
  return database;
}

export function mutateSchedulerState(filePath, fallback, callback) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const database = openLockDatabase(resolved);
  let transactionOpen = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const state = fs.existsSync(resolved)
      ? JSON.parse(fs.readFileSync(resolved, "utf8"))
      : structuredClone(fallback);
    const result = callback(state);
    const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, resolved);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return result === undefined ? state : result;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }
}
