require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const backups = require("./backup");

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:1234" }));
app.use(express.json({ limit: "256kb" }));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["admin", "serveur", "client"], required: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });
const User = mongoose.model("User", userSchema);

// A single versioned ledger makes stock, invoices and their history atomic on
// standalone MongoDB as well as replica sets.
const Ledger = mongoose.model("Ledger", new mongoose.Schema({
  _id: { type: String, default: "stock" },
  version: { type: Number, default: 0 },
  products: { type: [mongoose.Schema.Types.Mixed], default: [] },
  invoices: { type: [mongoose.Schema.Types.Mixed], default: [] },
  movements: { type: [mongoose.Schema.Types.Mixed], default: [] },
  invoiceSettings: { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { versionKey: false }));

const defaultInvoiceSettings = { businessName: "", phone: "", email: "", address: "", additionalInfo: "", footer: "Merci de votre visite !" };
const invoiceFieldLimits = { businessName: 120, phone: 80, email: 254, address: 300, additionalInfo: 500, footer: 300 };
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const text = (value, label, max = 120) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(400, `${label} invalide.`);
  return value.trim();
};
const quantity = (value, label = "Quantité") => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000) fail(400, `${label} invalide.`);
  return value;
};
const price = value => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1000000000) fail(400, "Le prix doit être un nombre entier positif.");
  return value;
};
const publicUser = user => ({ id: String(user._id), name: user.name, email: user.email, role: user.role, active: user.active !== false });
const sign = user => jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: "12h" });
const actor = user => ({ id: String(user._id), name: user.name });
const uid = () => crypto.randomUUID();

async function updateLedger(change) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await Ledger.findById("stock").lean();
    const state = current || { _id: "stock", version: 0, products: [], invoices: [], movements: [] };
    const result = change(state);
    if (!current) {
      try {
        await Ledger.create({ ...state, version: 1 });
        return result;
      } catch (error) {
        if (error.code === 11000) continue;
        throw error;
      }
    }
    const updated = await Ledger.updateOne({ _id: "stock", version: state.version }, {
      $set: { products: state.products, invoices: state.invoices, movements: state.movements, ...(state.invoiceSettings ? { invoiceSettings: state.invoiceSettings } : {}) },
      $inc: { version: 1 },
    });
    if (updated.modifiedCount === 1) return result;
  }
  fail(409, "Trop de modifications simultanées. Réessayez.");
}
const readLedger = async () => await Ledger.findById("stock").lean() || { products: [], invoices: [], movements: [] };
const addMovement = (state, product, type, delta, user, invoiceId = null) => {
  state.movements.unshift({ id: uid(), productId: product.id, productName: product.name, type, delta, total: product.stock, by: actor(user), invoiceId, date: new Date().toISOString() });
};

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.post("/api/auth/register", async (req, res) => {
  const name = text(req.body.name, "Prénom");
  const email = text(req.body.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Adresse email invalide.");
  const { password, confirmation, role, adminCode } = req.body;
  if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password) > 72) fail(400, "Le mot de passe doit contenir au moins 8 caractères et au maximum 72 octets.");
  if (password !== confirmation) fail(400, "Les mots de passe ne correspondent pas.");
  if (!["admin", "serveur", "client"].includes(role)) fail(400, "Rôle invalide.");
  if (role === "admin") {
    if (!process.env.ADMIN_REGISTRATION_CODE) fail(503, "L'inscription administrateur n'est pas configurée.");
    const expected = Buffer.from(process.env.ADMIN_REGISTRATION_CODE);
    const received = Buffer.from(typeof adminCode === "string" ? adminCode : "");
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) fail(403, "Code administrateur incorrect.");
  }
  const user = await User.create({ name, email, password: await bcrypt.hash(password, 12), role });
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});
app.post("/api/auth/login", async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const user = await User.findOne({ email });
  if (!user || typeof req.body.password !== "string" || !(await bcrypt.compare(req.body.password, user.password))) fail(401, "Email ou mot de passe incorrect.");
  if (user.active === false) fail(403, "Ce compte est désactivé. Contactez un administrateur.");
  res.json({ token: sign(user), user: publicUser(user) });
});
app.use("/api", async (req, res, next) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!match) return next(new HttpError(401, "Veuillez vous connecter."));
  let payload;
  try { payload = jwt.verify(match[1], process.env.JWT_SECRET); }
  catch { return next(new HttpError(401, "Session expirée ou invalide.")); }
  const user = await User.findById(payload.sub);
  if (!user) return next(new HttpError(401, "Compte introuvable."));
  if (user.active === false) return next(new HttpError(401, "Compte désactivé."));
  req.user = user;
  next();
});
const adminOnly = (req, res, next) => req.user.role === "admin" ? next() : next(new HttpError(403, "Action réservée aux administrateurs."));
app.get("/api/me", (req, res) => res.json(publicUser(req.user)));
app.get("/api/data", async (req, res) => {
  const state = await readLedger();
  res.json({ products: state.products.filter(p => !p.deleted), invoices: state.invoices.filter(i => !i.deleted), movements: state.movements, invoiceSettings: state.invoiceSettings || defaultInvoiceSettings });
});
app.get("/api/invoice-settings", async (req, res) => {
  const state = await readLedger();
  res.json(state.invoiceSettings || defaultInvoiceSettings);
});
app.put("/api/invoice-settings", adminOnly, async (req, res) => {
  const settings = {};
  for (const [field, limit] of Object.entries(invoiceFieldLimits)) {
    const value = req.body[field];
    if (typeof value !== "string" || value.trim().length > limit) fail(400, `Champ ${field} invalide (maximum ${limit} caractères).`);
    settings[field] = value.trim();
  }
  if (settings.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)) fail(400, "Adresse email invalide.");
  await updateLedger(state => { state.invoiceSettings = settings; });
  res.json(settings);
});
app.get("/api/users", adminOnly, async (req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.json(users.map(publicUser));
});
// Account changes are serialized by the single API process so two admins
// cannot concurrently remove each other's last administrator access.
let accountChanges = Promise.resolve();
app.put("/api/users/:id", adminOnly, async (req, res) => {
  const { role, active } = req.body;
  if (!["admin", "serveur", "client"].includes(role) || typeof active !== "boolean") fail(400, "Rôle ou statut invalide.");
  if (!mongoose.isValidObjectId(req.params.id)) fail(400, "Compte invalide.");
  const operation = accountChanges.then(async () => {
    const currentAdmin = await User.findById(req.user.id);
    if (!currentAdmin || currentAdmin.role !== "admin" || currentAdmin.active === false) fail(403, "Action réservée aux administrateurs actifs.");
    const target = await User.findById(req.params.id);
    if (!target) fail(404, "Compte introuvable.");
    if (target.role === "admin" && target.active !== false && (role !== "admin" || !active)) {
      const count = await User.countDocuments({ role: "admin", active: { $ne: false } });
      if (count <= 1) fail(409, "Il faut conserver au moins un administrateur actif.");
    }
    if (String(target._id) === String(currentAdmin._id) && (role !== "admin" || !active)) fail(409, "Vous ne pouvez pas désactiver ou rétrograder votre propre compte.");
    target.role = role;
    target.active = active;
    await target.save();
    return publicUser(target);
  });
  accountChanges = operation.then(() => undefined, () => undefined);
  res.json(await operation);
});
app.get("/api/backups/status", adminOnly, (req, res) => res.json(backups.status));
app.post("/api/products", async (req, res) => {
  const name = text(req.body.name, "Nom du produit");
  const category = text(req.body.category, "Catégorie");
  const stock = quantity(req.body.stock);
  const unitPrice = price(req.body.price);
  const lowStockThreshold = quantity(req.body.lowStockThreshold ?? 10, "Seuil d'alerte");
  const product = await updateLedger(state => {
    const item = { id: uid(), name, category, stock, price: unitPrice, lowStockThreshold, createdBy: actor(req.user), createdAt: new Date().toISOString(), deleted: false };
    state.products.unshift(item);
    addMovement(state, item, "creation", stock, req.user);
    return item;
  });
  res.status(201).json(product);
});
app.put("/api/products/:id", async (req, res) => {
  const name = text(req.body.name, "Nom du produit");
  const category = text(req.body.category, "Catégorie");
  const unitPrice = price(req.body.price);
  const addition = quantity(req.body.addition, "Quantité ajoutée");
  const lowStockThreshold = req.body.lowStockThreshold === undefined ? undefined : quantity(req.body.lowStockThreshold, "Seuil d'alerte");
  const product = await updateLedger(state => {
    const item = state.products.find(p => p.id === req.params.id && !p.deleted);
    if (!item) fail(404, "Produit introuvable.");
    if (item.stock + addition > 1000000000) fail(400, "Stock maximum dépassé.");
    Object.assign(item, { name, category, price: unitPrice, lowStockThreshold: lowStockThreshold ?? item.lowStockThreshold ?? 10 });
    if (addition) { item.stock += addition; addMovement(state, item, "approvisionnement", addition, req.user); }
    return item;
  });
  res.json(product);
});
app.delete("/api/products/:id", adminOnly, async (req, res) => {
  await updateLedger(state => {
    const product = state.products.find(p => p.id === req.params.id && !p.deleted);
    if (!product) fail(404, "Produit introuvable.");
    if (state.invoices.some(i => !i.deleted && i.status === "active" && i.items.some(item => item.productId === product.id))) fail(409, "Ce produit figure dans une facture active. Annulez d'abord cette facture.");
    product.deleted = true;
    addMovement(state, product, "suppression", 0, req.user);
  });
  res.json({ ok: true });
});
app.post("/api/invoices", async (req, res) => {
  const customer = text(req.body.customer, "Client");
  if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 100) fail(400, "Ajoutez entre 1 et 100 produits.");
  const items = req.body.items.map(item => {
    if (!item || typeof item.productId !== "string") fail(400, "Produit invalide.");
    const count = quantity(item.quantity);
    if (!count) fail(400, "La quantité doit être supérieure à zéro.");
    return { productId: item.productId, quantity: count };
  });
  if (new Set(items.map(i => i.productId)).size !== items.length) fail(400, "Un produit ne peut apparaître qu'une fois par facture.");
  const invoice = await updateLedger(state => {
    const id = uid();
    const lines = items.map(line => {
      const product = state.products.find(p => p.id === line.productId && !p.deleted);
      if (!product) fail(400, "Un produit sélectionné est introuvable.");
      if (product.stock < line.quantity) fail(409, `Stock insuffisant pour ${product.name} (disponible : ${product.stock}).`);
      product.stock -= line.quantity;
      addMovement(state, product, "vente", -line.quantity, req.user, id);
      return { productId: product.id, name: product.name, quantity: line.quantity, price: product.price };
    });
    const total = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
    if (!Number.isSafeInteger(total)) fail(400, "Le montant de la facture est trop élevé.");
    const item = { id, number: `FAC-${id.slice(0, 8).toUpperCase()}`, customer, items: lines, total, seller: actor(req.user), date: new Date().toISOString(), status: "active", deleted: false };
    state.invoices.unshift(item);
    return item;
  });
  res.status(201).json(invoice);
});
app.post("/api/invoices/:id/cancel", adminOnly, async (req, res) => {
  const invoice = await updateLedger(state => {
    const item = state.invoices.find(i => i.id === req.params.id && !i.deleted);
    if (!item) fail(404, "Facture introuvable.");
    if (item.status !== "active") fail(409, "Cette facture est déjà annulée.");
    for (const line of item.items) {
      const product = state.products.find(p => p.id === line.productId);
      if (!product || product.deleted) fail(409, "Impossible de restaurer un produit supprimé.");
      if (product.stock + line.quantity > 1000000000) fail(409, "Stock maximum dépassé lors de la restauration.");
      product.stock += line.quantity;
      addMovement(state, product, "annulation", line.quantity, req.user, item.id);
    }
    item.status = "cancelled";
    item.cancelledBy = actor(req.user);
    item.cancelledAt = new Date().toISOString();
    return item;
  });
  res.json(invoice);
});
app.delete("/api/invoices/:id", adminOnly, async (req, res) => {
  await updateLedger(state => {
    const item = state.invoices.find(i => i.id === req.params.id && !i.deleted);
    if (!item) fail(404, "Facture introuvable.");
    if (item.status === "active") {
      for (const line of item.items) {
        const product = state.products.find(p => p.id === line.productId);
        if (!product || product.deleted || product.stock + line.quantity > 1000000000) fail(409, "Impossible de restaurer le stock de cette facture.");
        product.stock += line.quantity;
        addMovement(state, product, "suppression facture", line.quantity, req.user, item.id);
      }
    }
    item.deleted = true;
    item.deletedBy = actor(req.user);
    item.deletedAt = new Date().toISOString();
  });
  res.json({ ok: true });
});
app.use((error, req, res, next) => {
  if (error.code === 11000) return res.status(409).json({ error: "Cette adresse email est déjà utilisée." });
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: "Données JSON invalides." });
  console.error(error);
  res.status(500).json({ error: "Une erreur serveur est survenue." });
});

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET doit contenir au moins 32 caractères.");
  if (!process.env.ADMIN_REGISTRATION_CODE) throw new Error("ADMIN_REGISTRATION_CODE doit être configuré.");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/white_mood");
  await User.init();
  backups.startBackups();
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`API disponible sur le port ${port}`));
}
if (require.main === module) start().catch(error => { console.error("Démarrage impossible :", error.message); process.exitCode = 1; });
module.exports = { app, start };
