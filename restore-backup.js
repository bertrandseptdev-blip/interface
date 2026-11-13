require("dotenv").config();
const fs = require("node:fs/promises");
const mongoose = require("mongoose");

async function restore() {
  const [file, target] = process.argv.slice(2);
  if (!file || !target || !/^white_mood_restore_[a-zA-Z0-9_]+$/.test(target)) {
    throw new Error("Usage : corepack yarn node restore-backup.js <fichier> white_mood_restore_<nom>");
  }
  const data = mongoose.mongo.BSON.EJSON.parse(await fs.readFile(file, "utf8"), { relaxed: false });
  if (data.format !== "white-mood-backup-v1" || !Array.isArray(data.users) || !Array.isArray(data.ledgers)) throw new Error("Fichier de sauvegarde invalide.");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/white_mood");
  const db = mongoose.connection.useDb(target).db;
  if ((await db.listCollections().toArray()).length) throw new Error("La base cible existe déjà : aucune donnée n'a été remplacée.");
  if (data.users.length) await db.collection("users").insertMany(data.users);
  if (data.ledgers.length) await db.collection("ledgers").insertMany(data.ledgers);
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  console.log(`Sauvegarde restaurée dans ${target}. Vérifiez les données avant toute mise en service.`);
}
restore().catch(error => { console.error("Restauration impossible :", error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
