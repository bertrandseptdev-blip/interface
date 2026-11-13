const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const directory = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backups"));
const status = { lastSuccess: null, error: null, directory };
let running = false;

async function backup(db = mongoose.connection.db, target = directory, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const filename = path.join(target, `white-mood-${day}.json`);
  try {
    await fs.access(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const users = await db.collection("users").find().toArray();
    const ledgers = await db.collection("ledgers").find().toArray();
    const payload = mongoose.mongo.BSON.EJSON.stringify({ format: "white-mood-backup-v1", createdAt: now, database: db.databaseName, users, ledgers }, { relaxed: false });
    const temporary = path.join(target, `.white-mood-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const files = (await fs.readdir(target)).filter(name => /^white-mood-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
  for (const old of files.slice(30)) await fs.unlink(path.join(target, old));
  return filename;
}

async function runBackup() {
  if (running) return;
  running = true;
  try {
    const file = await backup();
    status.lastSuccess = (await fs.stat(file)).mtime.toISOString();
    status.error = null;
  } catch (error) {
    status.error = error.message;
    console.error("Échec de la sauvegarde automatique :", error);
  } finally { running = false; }
}
function startBackups() {
  void runBackup();
  const timer = setInterval(runBackup, 60 * 1000);
  timer.unref();
}
module.exports = { backup, startBackups, status };
