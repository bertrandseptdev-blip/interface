const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { backup } = require("./backup");

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
process.env.ADMIN_REGISTRATION_CODE = "test-admin-code";
const { app } = require("./server");
const database = `white_mood_test_${crypto.randomBytes(8).toString("hex")}`;
let server;
let base;

before(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/${database}`, { serverSelectionTimeoutMS: 5000 });
  await mongoose.model("User").init();
  server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === database) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
async function call(path, { method = "GET", token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
const register = (name, role, adminCode) => call("/auth/register", {
  method: "POST",
  body: { name, email: `${name}@example.test`, password: "password-test", confirmation: "password-test", role, adminCode },
});

test("inscription, droits, mouvements et ventes concurrentes restent cohérents", async () => {
  assert.equal((await register("wrong", "admin", "incorrect")).status, 403);
  const admin = await register("admin", "admin", "test-admin-code");
  const client = await register("client", "client");
  const serveur = await register("serveur", "serveur");
  assert.equal(admin.status, 201);
  assert.equal(client.status, 201);
  assert.equal(serveur.status, 201);
  assert.equal((await register("client", "client")).status, 409);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "client@example.test", password: "wrong" } })).status, 401);
  assert.equal((await call("/users", { token: client.data.token })).status, 403);
  const product = await call("/products", { token: client.data.token, method: "POST", body: { name: "Produit", category: "Test", price: 250, stock: 5 } });
  assert.equal(product.status, 201);
  assert.equal((await call(`/products/${product.data.id}`, { token: serveur.data.token, method: "PUT", body: { name: "Produit", category: "Test", price: 250, addition: 1 } })).status, 200);
  assert.equal((await call(`/products/${product.data.id}`, { token: client.data.token, method: "DELETE" })).status, 403);
  const sale = token => call("/invoices", { token, method: "POST", body: { customer: "Acheteur", items: [{ productId: product.data.id, quantity: 4 }] } });
  const results = await Promise.all([sale(client.data.token), sale(serveur.data.token)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const invoice = results.find(r => r.status === 201).data;
  assert.equal(invoice.total, 1000);
  assert.equal((await call(`/invoices/${invoice.id}/cancel`, { token: client.data.token, method: "POST" })).status, 403);
  assert.equal((await call(`/products/${product.data.id}`, { token: admin.data.token, method: "DELETE" })).status, 409);
  let state = await call("/data", { token: client.data.token });
  assert.equal(state.data.products[0].stock, 2);
  assert.deepEqual(state.data.movements.map(m => m.delta), [-4, 1, 5]);
  assert.equal((await call(`/invoices/${invoice.id}/cancel`, { token: admin.data.token, method: "POST" })).status, 200);
  assert.equal((await call(`/invoices/${invoice.id}/cancel`, { token: admin.data.token, method: "POST" })).status, 409);
  assert.equal((await call(`/invoices/${invoice.id}`, { token: admin.data.token, method: "DELETE" })).status, 200);
  state = await call("/data", { token: client.data.token });
  assert.equal(state.data.products[0].stock, 6);
  assert.equal(state.data.invoices.length, 0);
  assert.deepEqual(state.data.movements.map(m => m.delta), [4, -4, 1, 5]);
  const second = await sale(client.data.token);
  assert.equal(second.status, 201);
  assert.equal((await call(`/invoices/${second.data.id}`, { token: admin.data.token, method: "DELETE" })).status, 200);
  state = await call("/data", { token: client.data.token });
  assert.equal(state.data.products[0].stock, 6);
  assert.equal(state.data.movements[0].type, "suppression facture");
  assert.equal((await call(`/products/${product.data.id}`, { token: admin.data.token, method: "DELETE" })).status, 200);
});

test("personnalisation persistante réservée aux administrateurs", async () => {
  const admin = await call("/auth/login", { method: "POST", body: { email: "admin@example.test", password: "password-test" } });
  const client = await call("/auth/login", { method: "POST", body: { email: "client@example.test", password: "password-test" } });
  const defaults = await call("/invoice-settings", { token: client.data.token });
  assert.equal(defaults.data.footer, "Merci de votre visite !");
  const settings = { businessName: "White Mood", phone: "+243 123", email: "contact@example.test", address: "Rue 1\nVille", additionalInfo: "N° fiscal 42", footer: "À bientôt" };
  assert.equal((await call("/invoice-settings", { method: "PUT", token: client.data.token, body: settings })).status, 403);
  assert.equal((await call("/invoice-settings", { method: "PUT", token: admin.data.token, body: { ...settings, email: "invalide" } })).status, 400);
  assert.equal((await call("/invoice-settings", { method: "PUT", token: admin.data.token, body: { ...settings, footer: "x".repeat(301) } })).status, 400);
  assert.equal((await call("/invoice-settings", { method: "PUT", token: admin.data.token, body: settings })).status, 200);
  const product = await call("/products", { token: client.data.token, method: "POST", body: { name: "Sauvegarde", category: "Test", price: 1, stock: 1 } });
  assert.equal(product.status, 201);
  assert.deepEqual((await call("/invoice-settings", { token: client.data.token })).data, settings);
  assert.deepEqual((await call("/data", { token: client.data.token })).data.invoiceSettings, settings);
});

test("seuils, gestion des comptes et sessions désactivées", async () => {
  const admin = await call("/auth/login", { method: "POST", body: { email: "admin@example.test", password: "password-test" } });
  const client = await call("/auth/login", { method: "POST", body: { email: "client@example.test", password: "password-test" } });
  const admin2 = await register("admin2", "admin", "test-admin-code");
  const product = await call("/products", { token: client.data.token, method: "POST", body: { name: "Alerte", category: "Test", price: 1, stock: 10 } });
  assert.equal(product.data.lowStockThreshold, 10);
  assert.equal((await call(`/products/${product.data.id}`, { token: client.data.token, method: "PUT", body: { name: "Alerte", category: "Test", price: 1, addition: 0, lowStockThreshold: 3 } })).data.lowStockThreshold, 3);
  assert.equal((await call(`/products/${product.data.id}`, { token: client.data.token, method: "PUT", body: { name: "Alerte", category: "Test", price: 1, addition: 0 } })).data.lowStockThreshold, 3);
  assert.equal((await call(`/products/${product.data.id}`, { token: client.data.token, method: "PUT", body: { name: "Alerte", category: "Test", price: 1, addition: 0, lowStockThreshold: -1 } })).status, 400);
  assert.equal((await call(`/users/${client.data.user.id}`, { method: "PUT", token: client.data.token, body: { role: "admin", active: true } })).status, 403);
  assert.equal((await call(`/users/${client.data.user.id}`, { method: "PUT", token: admin.data.token, body: { role: "serveur", active: false } })).status, 200);
  assert.equal((await call("/data", { token: client.data.token })).status, 401);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "client@example.test", password: "password-test" } })).status, 403);
  assert.equal((await call(`/users/${client.data.user.id}`, { method: "PUT", token: admin.data.token, body: { role: "serveur", active: true } })).status, 200);
  assert.equal((await call("/me", { token: client.data.token })).data.role, "serveur");
  assert.equal((await call(`/users/${admin.data.user.id}`, { method: "PUT", token: admin2.data.token, body: { role: "client", active: true } })).status, 200);
  assert.equal((await call(`/users/${admin2.data.user.id}`, { method: "PUT", token: admin2.data.token, body: { role: "client", active: true } })).status, 409);
  assert.equal((await call("/users", { token: admin.data.token })).status, 403);
});

test("sauvegarde, rétention et restauration sans écraser une base existante", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "white-backup-test-"));
  const target = `white_mood_restore_${crypto.randomBytes(6).toString("hex")}`;
  try {
    const file = await backup(mongoose.connection.db, directory, new Date("2026-01-10T12:00:00Z"));
    const contents = mongoose.mongo.BSON.EJSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(contents.format, "white-mood-backup-v1");
    assert.ok(contents.users.length >= 3);
    assert.ok(contents.ledgers.length);
    await promisify(execFile)(process.execPath, [path.join(__dirname, "restore-backup.js"), file, target], { env: { ...process.env, MONGODB_URI: `mongodb://127.0.0.1:27017/${database}` } });
    const restored = mongoose.connection.useDb(target).db;
    assert.equal(await restored.collection("users").countDocuments(), contents.users.length);
    assert.equal(await restored.collection("ledgers").countDocuments(), contents.ledgers.length);
    const restoredUser = await restored.collection("users").findOne({ email: "client@example.test" });
    assert.ok(restoredUser._id instanceof mongoose.Types.ObjectId);
    assert.ok(await require("bcrypt").compare("password-test", restoredUser.password));
    const restoredLedger = await restored.collection("ledgers").findOne({ _id: "stock" });
    assert.equal(restoredLedger.products.find(p => p.name === "Alerte").lowStockThreshold, 3);
    assert.equal(restoredLedger.invoiceSettings.businessName, "White Mood");
    assert.equal(restoredLedger.invoiceSettings.phone, "+243 123");
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(__dirname, "restore-backup.js"), file, target], { env: { ...process.env, MONGODB_URI: `mongodb://127.0.0.1:27017/${database}` } }));
    for (let day = 1; day <= 31; day++) await backup(mongoose.connection.db, directory, new Date(2026, 2, day, 12));
    const files = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
    assert.equal(files.length, 30);
    assert.equal(files.includes("white-mood-2026-01-10.json"), false);
  } finally {
    await mongoose.connection.useDb(target).dropDatabase();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
