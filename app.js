"use strict";

/* =====================================================
   Collecto : jeu de cartes à collectionner
   - cartes dans cards.json (images en chemins locaux)
   - comptes et données de jeu dans Supabase (config.js)
   - le serveur décide de tout ce qui compte : tirage des cartes, recharge
     des boosters, ventes. L'application affiche et demande.
   ===================================================== */

/* ---------- Réglages d'affichage ---------- */

const CURRENCY = "Abri$";
const START_ABRIS = 300;                  // doit correspondre au "default" de profiles.abris (schema.sql)
const MAX_BOOSTERS = 5;                   // idem : profiles.boosters, fonction private.regen
const BOOSTER_SIZE = 5;                   // idem : open_booster
const BOOSTER_EVERY_MS = 60 * 60 * 1000;  // idem : private.regen (1 heure)

// 6 raretés. Ici : couleurs, textes et valeurs AFFICHÉES. Les vraies probabilités et les
// vrais prix de revente sont dans la table "rarities" de Supabase (schema.sql).
const RARITIES = [
  { key: "commun",     label: "Commun",     tagline: "Peut mieux faire", color: "#6d9eeb", weight: 60,   sell: 5 },
  { key: "peu-commun", label: "Peu commun", tagline: "Encouragements",   color: "#8e7cc3", weight: 25,   sell: 10 },
  { key: "rare",       label: "Rare",       tagline: "Bien",             color: "#c27ba0", weight: 10,   sell: 25 },
  { key: "epique",     label: "Épique",     tagline: "Très bien",        color: "#e06666", weight: 4,    sell: 75 },
  { key: "legendaire", label: "Légendaire", tagline: "Félicitations",    color: "#f6b26b", weight: 0.9,  sell: 200 },
  { key: "divin",      label: "Divin",      tagline: "Hors-barème",      color: "#ffd966", weight: 0.1,  sell: 500 },
];
RARITIES.forEach((r, i) => { r.tier = i; });
const RARITY_BY_KEY = new Map(RARITIES.map((r) => [r.key, r]));

/* ---------- Configuration Supabase ---------- */

const CFG = window.COLLECTO_CONFIG || {};
const EMAIL_DOMAIN = CFG.EMAIL_DOMAIN || "collecto.game";
const PIN_PEPPER = CFG.PIN_PEPPER || "-collecto";

const isPlaceholder = (v) => !v || /VOTRE/i.test(v);
const configMissing = isPlaceholder(CFG.SUPABASE_URL) || isPlaceholder(CFG.SUPABASE_ANON_KEY);

let sb = null;
if (!configMissing && window.supabase) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "collecto-auth" },
  });
}

// Supabase identifie un compte par e-mail + mot de passe : on les fabrique à partir du pseudo et du PIN.
// Aucun e-mail n'est envoyé. Le texte ajouté au PIN sert uniquement à atteindre 6 caractères.
const emailFor = (pseudo) => `${pseudo.toLowerCase()}@${EMAIL_DOMAIN}`;
const passwordFor = (pin) => `${pin}${PIN_PEPPER}`;
const PSEUDO_RE = /^[A-Za-z0-9_-]{3,16}$/;

/* ---------- Éléments de page & état ---------- */

const $app = document.getElementById("app");
const $modal = document.getElementById("modal");
const $toasts = document.getElementById("toasts");

let catalog = [];
const byId = new Map();
const byRarity = new Map();   // clé de rareté -> cartes
const tree = new Map();       // catégorie -> Set(sous-catégories)
let catalogIssues = [];

// Profil du joueur connecté (copie du profil distant) : { pseudo, abris, boosters, owned, lastTick }
let me = null;
let clockOffset = 0;          // heure du serveur - heure de l'appareil (ms)

const ui = {
  tab: "boosters",            // boosters | collection | profile
  loading: true,
  fatal: null,                // message d'erreur bloquant
  busy: false,                // une action est en cours auprès du serveur
  opening: null,              // booster en cours d'ouverture
  cat: null,
  sub: null,
  modal: null,                // { id, confirm }
  authMode: null,             // login | create
  confirmReset: false,
};

/* ---------- Utilitaires ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("fr-FR") : String(n));
const money = (n) => `${fmtNum(n)} ${CURRENCY}`;

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

function toast(text) {
  const t = el("div", { class: "toast" }, text);
  $toasts.append(t);
  setTimeout(() => t.remove(), 3500);
}

// "Épique", "epique", "Peu commun", "peu_commun"... -> "epique", "peu-commun"
const normKey = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[\s_]+/g, "-");

/* ---------- Échanges avec Supabase ---------- */

function friendlyError(err) {
  const msg = String((err && err.message) || err || "");
  const status = err && err.status;
  if (/Invalid login credentials/i.test(msg)) return "Pseudo ou code PIN incorrect.";
  if (/already registered|already been registered/i.test(msg)) return "Ce pseudo existe déjà. Choisis-en un autre ou connecte-toi.";
  if (/Database error saving new user/i.test(msg)) return "Création impossible : pseudo invalide ou déjà pris.";
  if (status === 429 || /rate limit|too many/i.test(msg)) return "Trop de tentatives. Réessaie dans quelques minutes.";
  if (/CONFIRM_EMAIL/.test(msg)) return "Configuration : désactive « Confirm email » dans Supabase (Authentication > Sign In / Providers > Email).";
  if (/email.*(invalid|not allowed)|invalid.*email/i.test(msg)) return "Configuration : Supabase refuse le domaine e-mail. Change EMAIL_DOMAIN dans config.js.";
  if (/no_booster/.test(msg)) return "Plus aucun booster disponible.";
  if (/not_enough_cards/.test(msg)) return "Tu ne possèdes pas assez d'exemplaires de cette carte.";
  if (/no_cards/.test(msg)) return "Aucune carte n'est enregistrée sur le serveur (exécute seed_cards.sql).";
  if (/unknown_card/.test(msg)) return "Cette carte n'est pas connue du serveur (exécute seed_cards.sql).";
  if (/profile_not_found|not_authenticated|JWT/i.test(msg)) return "Session expirée. Reconnecte-toi.";
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return "Connexion impossible. Vérifie ta connexion internet.";
  return "Erreur : " + msg;
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

function applyProfile(j) {
  me = { pseudo: j.pseudo, abris: j.abris, boosters: j.boosters, owned: j.owned || {}, lastTick: j.last_tick_ms };
  clockOffset = j.server_now_ms - Date.now();
}

// Appelle une fonction serveur qui renvoie le profil. Si deux réponses se croisent,
// seule la plus récente (dans l'ordre d'envoi) met à jour l'écran.
let seqIssued = 0;
let seqApplied = 0;
async function profileCall(name, args) {
  const seq = ++seqIssued;
  const j = await rpc(name, args);
  if (seq > seqApplied) { seqApplied = seq; applyProfile(j); }
  return j;
}

let lastRefresh = 0;
async function refreshProfile({ force = false } = {}) {
  if (!me || (!force && Date.now() - lastRefresh < 3000)) return;
  lastRefresh = Date.now();
  try {
    await profileCall("get_profile");
    if (!ui.opening) { render(); if (ui.modal) renderModal(); }
  } catch (err) {
    console.warn("[refresh]", err);
  }
}

/* ---------- Boosters : miroir local de la recharge horaire ---------- */

// Le serveur est la référence (private.regen). Ce miroir fait seulement apparaître
// le nouveau booster à la seconde près, sans attendre une requête.
const nowServer = () => Date.now() + clockOffset;

function syncBoosters(p, now = nowServer()) {
  if (p.boosters >= MAX_BOOSTERS) return 0;
  if (now < p.lastTick) return 0;
  const gained = Math.floor((now - p.lastTick) / BOOSTER_EVERY_MS);
  if (gained <= 0) return 0;
  const before = p.boosters;
  p.boosters = Math.min(MAX_BOOSTERS, p.boosters + gained);
  p.lastTick += gained * BOOSTER_EVERY_MS;
  return p.boosters - before;
}

function msToNextBooster(p, now = nowServer()) {
  if (p.boosters >= MAX_BOOSTERS) return 0;
  return Math.max(0, p.lastTick + BOOSTER_EVERY_MS - now);
}

/* ---------- Catalogue (cards.json) ---------- */

function normalizeCard(raw, index) {
  const label = `carte n°${index + 1}${raw && raw.id ? ` (${raw.id})` : ""}`;
  if (!raw || !raw.id || !raw.titre) {
    catalogIssues.push(`${label} : "id" et "titre" sont obligatoires.`);
    return null;
  }
  const rarity = RARITY_BY_KEY.get(normKey(raw.rarete));
  if (!rarity) {
    catalogIssues.push(`${label} : rareté "${raw.rarete}" inconnue (attendu : ${RARITIES.map((r) => r.label).join(", ")}).`);
    return null;
  }
  if (byId.has(String(raw.id))) {
    catalogIssues.push(`${label} : id déjà utilisé.`);
    return null;
  }
  return {
    id: String(raw.id),
    titre: String(raw.titre),
    categorie: raw.categorie ? String(raw.categorie) : "Divers",
    sous: raw.sous_categorie ? String(raw.sous_categorie) : "",
    rarity,
    stats: raw.statistiques && typeof raw.statistiques === "object" ? Object.entries(raw.statistiques) : [],
    image: raw.image ? String(raw.image) : "",
    description: raw.description ? String(raw.description) : "",
  };
}

function buildCatalog(rawCards) {
  catalog = [];
  catalogIssues = [];
  byId.clear();
  byRarity.clear();
  tree.clear();
  rawCards.forEach((raw, i) => {
    const card = normalizeCard(raw, i);
    if (!card) return;
    byId.set(card.id, card);
    catalog.push(card);
    if (!byRarity.has(card.rarity.key)) byRarity.set(card.rarity.key, []);
    byRarity.get(card.rarity.key).push(card);
    if (!tree.has(card.categorie)) tree.set(card.categorie, new Set());
    if (card.sous) tree.get(card.categorie).add(card.sous);
  });
  catalogIssues.forEach((msg) => console.warn("[cards.json]", msg));
}

// Carte reçue du serveur mais absente de cards.json (fichier pas à jour) : on affiche quand même quelque chose
function cardFromServer(id, rarete) {
  return byId.get(id) || {
    id, titre: id, categorie: "Divers", sous: "",
    rarity: RARITY_BY_KEY.get(rarete) || RARITIES[0],
    stats: [], image: "", description: "Carte absente de ton cards.json local.",
  };
}

/* ---------- Collection ---------- */

function collectionStats(cat = null, sub = null) {
  const cards = catalog.filter((c) => (!cat || c.categorie === cat) && (!sub || c.sous === sub));
  const owned = cards.filter((c) => (me.owned[c.id] || 0) > 0).length;
  return { owned, total: cards.length };
}

const fmtStats = (s) => `(${s.owned}/${s.total})`;

/* ---------- Actions (toutes passent par le serveur) ---------- */

async function doOpenBooster() {
  if (ui.busy || !me || me.boosters <= 0) return;
  ui.busy = "open";
  render();
  try {
    const j = await profileCall("open_booster");
    ui.opening = j.cards.map((c) => ({ card: cardFromServer(c.id, c.rarete), isNew: c.is_new, revealed: false }));
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  render();
}

async function sell(card, qty) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const j = await profileCall("sell_cards", { p_card_id: card.id, p_qty: qty });
    toast(`+${money(j.gain)}`);
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  render();
  renderModal();
}

async function resetCollection() {
  if (ui.busy) return;
  ui.busy = true;
  try {
    await profileCall("reset_collection");
    toast("Collection remise à zéro.");
  } catch (err) {
    toast(friendlyError(err));
  }
  ui.busy = false;
  ui.confirmReset = false;
  render();
}

async function logout() {
  try { await sb.auth.signOut(); } catch (err) { console.warn("[signOut]", err); }
  me = null;
  ui.opening = null;
  ui.cat = ui.sub = null;
  ui.confirmReset = false;
  ui.authMode = null;
  closeModal();
  render();
}

// Charge le profil après une connexion réussie (ou au retour sur l'app)
async function enterGame({ isNew = false } = {}) {
  const j = await profileCall("get_profile");
  ui.tab = "boosters";
  ui.opening = null;
  ui.fatal = null;
  ui.loading = false;
  render();
  if (isNew) toast(`Bienvenue ${me.pseudo} ! ${money(START_ABRIS)} offerts.`);
  else if (j.gained > 0) toast(`📦 +${j.gained} booster${j.gained > 1 ? "s" : ""} reçu${j.gained > 1 ? "s" : ""} pendant ton absence`);
}

/* ---------- Interface : carte ---------- */

function cardArt(card) {
  const art = el("div", { class: "g-art" });
  const fallback = () => el("div", { class: "g-fallback" }, "🃏");
  if (card.image) {
    const img = el("img", { src: card.image, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(fallback()));
    art.append(img);
  } else {
    art.append(fallback());
  }
  return art;
}

function cardFace(card, { big = false } = {}) {
  const r = card.rarity;
  const node = el("div", { class: "gcard" + (big ? " big" : ""), "data-tier": String(r.tier) },
    cardArt(card),
    el("div", { class: "g-name" }, card.titre),
    el("div", { class: "g-meta" }, r.label)
  );
  node.style.setProperty("--rc", r.color);
  return node;
}

/* ---------- Interface : fiche d'une carte (modale) ---------- */

function showCard(card) {
  ui.modal = { id: card.id, confirm: false };
  renderModal();
}

function closeModal() {
  ui.modal = null;
  $modal.replaceChildren();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function renderModal() {
  if (!ui.modal || !me) return closeModal();
  const card = byId.get(ui.modal.id);
  const count = card ? me.owned[card.id] || 0 : 0;
  if (!card || !count) return closeModal();

  const r = card.rarity;
  const sellButtons = [];
  if (count > 1) {
    sellButtons.push(el("button", { class: "secondary", onclick: () => sell(card, 1) },
      `Vendre 1 exemplaire · +${money(r.sell)}`));
  }
  if (count > 2) {
    sellButtons.push(el("button", { class: "secondary", onclick: () => sell(card, count - 1) },
      `Vendre les ${count - 1} doublons · +${money((count - 1) * r.sell)}`));
  }
  if (count === 1) {
    sellButtons.push(ui.modal.confirm
      ? el("button", { class: "secondary danger", onclick: () => sell(card, 1) },
          `Confirmer : vendre mon dernier exemplaire · +${money(r.sell)}`)
      : el("button", { class: "secondary", onclick: () => { ui.modal.confirm = true; renderModal(); } },
          `Vendre mon dernier exemplaire · +${money(r.sell)}`));
  }

  const box = el("div", { class: "modal-box", role: "dialog", "aria-label": card.titre },
    cardFace(card, { big: true }),
    el("p", { class: "tagline" }, `${r.label} · ${r.tagline}`),
    card.description ? el("p", { class: "center" }, card.description) : null,
    card.stats.length
      ? el("dl", { class: "stats" },
          card.stats.map(([k, v]) => el("div", { class: "stat" }, el("dt", {}, k), el("dd", {}, fmtNum(v)))))
      : null,
    el("p", { class: "muted small center" },
      `${card.categorie}${card.sous ? " › " + card.sous : ""} · en ta possession : ×${count}`),
    sellButtons,
    el("button", { class: "secondary", onclick: closeModal }, "Fermer")
  );
  box.style.setProperty("--rc", r.color);

  $modal.replaceChildren(
    el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } }, box)
  );
}

/* ---------- Interface : écrans sans profil ---------- */

function viewMessage(title, ...lines) {
  return el("section", { class: "auth" },
    el("div", { class: "pack" }, "🃏"),
    el("h1", {}, title),
    lines.map((l) => (typeof l === "string" ? el("p", { class: "muted center" }, l) : l))
  );
}

function viewSetup() {
  return viewMessage("Collecto",
    window.supabase
      ? "Supabase n'est pas configuré. Ouvre config.js et renseigne SUPABASE_URL et SUPABASE_ANON_KEY (Supabase > Project Settings > API)."
      : "La bibliothèque Supabase n'a pas pu être chargée. Vérifie ta connexion internet et recharge la page."
  );
}

function viewFatal() {
  return viewMessage("Oups", ui.fatal,
    el("button", { class: "primary", onclick: () => location.reload() }, "Réessayer"),
    sb ? el("button", { class: "linklike", onclick: async () => { ui.fatal = null; await logout(); } }, "Se déconnecter") : null);
}

function viewAuth() {
  const mode = ui.authMode || "login";
  const isCreate = mode === "create";

  const error = el("p", { class: "form-error", role: "alert" });
  const digitsOnly = (input) => input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
  });

  const pseudo = el("input", {
    id: "auth-pseudo", type: "text", maxlength: "16", autocomplete: "username",
    autocapitalize: "off", spellcheck: "false", placeholder: "Ton pseudo",
  });
  const pinAttrs = { type: "password", inputmode: "numeric", maxlength: "4", pattern: "[0-9]*", placeholder: "••••" };
  const pin = el("input", { ...pinAttrs, id: "auth-pin", autocomplete: isCreate ? "new-password" : "current-password" });
  const pin2 = isCreate ? el("input", { ...pinAttrs, id: "auth-pin2", autocomplete: "new-password" }) : null;
  digitsOnly(pin);
  if (pin2) digitsOnly(pin2);

  const submit = el("button", { class: "primary", type: "submit" },
    isCreate ? `Créer mon profil · ${START_ABRIS} ${CURRENCY} offerts` : "Se connecter");

  const form = el("form", { class: "auth-form", novalidate: "" },
    el("label", { class: "field", for: "auth-pseudo" }, "Pseudo", pseudo),
    isCreate ? el("p", { class: "muted small hint" }, "3 à 16 caractères : lettres, chiffres, _ ou -") : null,
    el("label", { class: "field", for: "auth-pin" }, "Code PIN (4 chiffres)", pin),
    pin2 ? el("label", { class: "field", for: "auth-pin2" }, "Confirme le code PIN", pin2) : null,
    error,
    submit
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    const name = pseudo.value.trim();
    const code = pin.value;
    const fail = (msg) => { error.textContent = msg; };
    error.textContent = "";

    if (!PSEUDO_RE.test(name)) return fail("Pseudo : 3 à 16 caractères (lettres, chiffres, _ ou -).");
    if (!/^\d{4}$/.test(code)) return fail("Le code PIN doit contenir exactement 4 chiffres.");
    if (isCreate && pin2.value !== code) return fail("Les deux codes PIN ne correspondent pas.");

    ui.busy = true;
    submit.disabled = true;
    submit.textContent = "Connexion…";
    try {
      if (isCreate) {
        const { data, error: err } = await sb.auth.signUp({
          email: emailFor(name),
          password: passwordFor(code),
          options: { data: { pseudo: name } },
        });
        if (err) throw err;
        if (!data.session) throw new Error("CONFIRM_EMAIL");
      } else {
        const { error: err } = await sb.auth.signInWithPassword({ email: emailFor(name), password: passwordFor(code) });
        if (err) throw err;
      }
      ui.busy = false;   // avant enterGame : il affiche déjà l'écran de jeu
      await enterGame({ isNew: isCreate });
    } catch (err) {
      fail(friendlyError(err));
      submit.disabled = false;
      submit.textContent = isCreate ? `Créer mon profil · ${START_ABRIS} ${CURRENCY} offerts` : "Se connecter";
    } finally {
      ui.busy = false;
    }
  });

  const switcher = el("button", {
    class: "linklike", type: "button",
    onclick: () => { ui.authMode = isCreate ? "login" : "create"; render(); },
  }, isCreate ? "J'ai déjà un profil" : "Créer un nouveau profil");

  return el("section", { class: "auth" },
    el("div", { class: "pack" }, "🃏"),
    el("h1", {}, "Collecto"),
    el("p", { class: "muted center" }, isCreate ? "Crée ton profil pour commencer ta collection." : "Connecte-toi pour retrouver ta collection."),
    form,
    switcher
  );
}

/* ---------- Interface : structure ---------- */

function header() {
  return el("header", { class: "topbar" },
    el("strong", {}, "🃏 Collecto"),
    el("div", { class: "pills" },
      el("span", { class: "pill", title: "Boosters en stock" }, "📦 ", el("span", { "data-stock": "" }, `${me.boosters}/${MAX_BOOSTERS}`)),
      el("span", { class: "pill gold", title: "Ton solde" }, money(me.abris))
    )
  );
}

function nav() {
  const tab = (id, label) =>
    el("button", {
      class: "nav-btn" + (ui.tab === id ? " active" : ""),
      onclick: () => { ui.tab = id; ui.confirmReset = false; render(); window.scrollTo(0, 0); },
    }, label);
  return el("nav", { class: "nav" },
    tab("boosters", "📦 Boosters"),
    tab("collection", "🗂️ Collection"),
    tab("profile", "👤 Profil")
  );
}

function render() {
  if (configMissing || !sb) return $app.replaceChildren(viewSetup());
  if (ui.fatal) return $app.replaceChildren(viewFatal());
  if (ui.loading) return $app.replaceChildren(el("p", { class: "muted center loading" }, "Chargement…"));
  if (!me) return $app.replaceChildren(viewAuth());
  const view = ui.tab === "boosters" ? viewBoosters()
    : ui.tab === "collection" ? viewCollection()
    : viewProfile();
  $app.replaceChildren(header(), view, nav());
}

/* ---------- Interface : boosters ---------- */

function viewBoosters() {
  if (ui.opening) return viewOpening();

  const full = me.boosters >= MAX_BOOSTERS;
  const pips = el("div", { class: "pips", role: "img", "aria-label": `${me.boosters} boosters sur ${MAX_BOOSTERS}` },
    Array.from({ length: MAX_BOOSTERS }, (_, i) => el("span", { class: "pip" + (i < me.boosters ? " on" : "") })));

  const timer = full
    ? el("p", { class: "muted center small" }, "Stock plein. Ouvre un booster pour relancer le compteur.")
    : el("p", { class: "muted center" }, "Prochain booster dans ",
        el("strong", { "data-countdown": "" }, fmtClock(msToNextBooster(me))));

  const canOpen = me.boosters > 0 && !ui.busy;

  return el("section", { class: "view" },
    el("div", { class: "pack" }, "📦"),
    pips,
    el("p", { class: "center stock-line" }, `${me.boosters} / ${MAX_BOOSTERS} boosters`),
    timer,
    el("button", {
      class: "primary", disabled: canOpen ? null : "",
      onclick: doOpenBooster,
    }, ui.busy === "open" ? "Ouverture…" : me.boosters > 0 ? `Ouvrir un booster (${BOOSTER_SIZE} cartes)` : "Aucun booster disponible"),
    el("h2", { class: "section-title" }, "Chances par carte et prix de revente"),
    el("div", { class: "odds" },
      RARITIES.map((r) => {
        const row = el("div", { class: "odd" },
          el("span", { class: "dot" }),
          el("span", { class: "odd-name" }, el("strong", {}, r.label), el("small", {}, r.tagline)),
          el("span", { class: "odd-pct" }, `${r.weight.toLocaleString("fr-FR")} %`),
          el("span", { class: "odd-sell" }, money(r.sell)));
        row.style.setProperty("--rc", r.color);
        return row;
      }))
  );
}

function viewOpening() {
  const items = ui.opening;
  const controls = el("div", { class: "controls" });

  const updateControls = () => {
    const allRevealed = items.every((i) => i.revealed);
    controls.replaceChildren(
      allRevealed
        ? el("button", { class: "primary", onclick: () => { ui.opening = null; render(); } }, "Continuer")
        : el("button", { class: "secondary", onclick: () => items.forEach((i) => i.reveal()) }, "Tout révéler")
    );
  };

  const grid = el("div", { class: "reveal-grid" });
  for (const item of items) {
    const btn = el("button", { class: "flip", "aria-label": "Retourner la carte", "data-tier": String(item.card.rarity.tier) },
      el("div", { class: "flip-inner" },
        el("div", { class: "face front" }, "?"),
        el("div", { class: "face back" },
          cardFace(item.card),
          item.isNew ? el("span", { class: "new" }, "NEW") : null
        )
      )
    );
    btn.style.setProperty("--rc", item.card.rarity.color);
    item.reveal = () => {
      if (item.revealed) return;
      item.revealed = true;
      btn.classList.add("revealed");
      updateControls();
    };
    btn.addEventListener("click", item.reveal);
    grid.append(btn);
  }
  updateControls();

  return el("section", { class: "view" },
    el("p", { class: "muted center" }, "Touche les cartes pour les retourner"),
    grid,
    controls
  );
}

/* ---------- Interface : collection ---------- */

function viewCollection() {
  const chip = (label, active, onclick) =>
    el("button", { class: "chip" + (active ? " active" : ""), onclick }, label);

  const catRow = el("div", { class: "chips" },
    chip(`Tout ${fmtStats(collectionStats())}`, !ui.cat, () => { ui.cat = null; ui.sub = null; render(); }),
    [...tree.keys()].map((c) =>
      chip(`${c} ${fmtStats(collectionStats(c))}`, ui.cat === c, () => { ui.cat = c; ui.sub = null; render(); }))
  );

  const subs = ui.cat ? [...tree.get(ui.cat)] : [];
  const subRow = subs.length
    ? el("div", { class: "chips sub" },
        chip("Toutes", !ui.sub, () => { ui.sub = null; render(); }),
        subs.map((s) =>
          chip(`${s} ${fmtStats(collectionStats(ui.cat, s))}`, ui.sub === s, () => { ui.sub = s; render(); }))
      )
    : null;

  const cards = catalog.filter((c) => (!ui.cat || c.categorie === ui.cat) && (!ui.sub || c.sous === ui.sub));

  const grid = el("div", { class: "tile-grid" },
    cards.map((card) => {
      const count = me.owned[card.id] || 0;
      if (!count) {
        return el("div", { class: "tile missing" },
          el("div", { class: "g-emoji" }, "?"),
          el("div", { class: "g-meta" }, "Pas encore découverte"));
      }
      return el("button", { class: "tile", onclick: () => showCard(card) },
        cardFace(card),
        count > 1 ? el("span", { class: "count" }, `×${count}`) : null
      );
    })
  );

  const issues = catalogIssues.length
    ? el("p", { class: "warning" }, `⚠️ ${catalogIssues.length} carte(s) de cards.json ignorée(s). Détails dans la console du navigateur.`)
    : null;

  return el("section", { class: "view" }, issues, catRow, subRow, grid);
}

/* ---------- Interface : profil ---------- */

function viewProfile() {
  const s = collectionStats();
  const copies = Object.values(me.owned).reduce((a, b) => a + b, 0);

  const rows = RARITIES.map((r) => {
    const all = byRarity.get(r.key) || [];
    const have = all.filter((c) => (me.owned[c.id] || 0) > 0).length;
    const row = el("div", { class: "odd" },
      el("span", { class: "dot" }),
      el("span", { class: "odd-name" }, el("strong", {}, r.label)),
      el("span", { class: "odd-pct" }, `${have} / ${all.length}`));
    row.style.setProperty("--rc", r.color);
    return row;
  });

  const reset = ui.confirmReset
    ? el("div", { class: "reset-row" },
        el("button", { class: "secondary danger", onclick: resetCollection }, "Oui, effacer mes cartes"),
        el("button", { class: "secondary", onclick: () => { ui.confirmReset = false; render(); } }, "Annuler"))
    : el("button", { class: "linklike", onclick: () => { ui.confirmReset = true; render(); } }, "Remettre ma collection à zéro");

  return el("section", { class: "view" },
    el("h2", { class: "section-title" }, me.pseudo),
    el("p", { class: "muted" }, `${money(me.abris)} · ${s.owned} / ${s.total} cartes uniques · ${copies} cartes au total`),
    el("h2", { class: "section-title" }, "Progression par rareté"),
    el("div", { class: "odds" }, rows),
    el("button", { class: "secondary", onclick: logout }, "Se déconnecter"),
    reset
  );
}

/* ---------- Boucle de temps (recharge des boosters) ---------- */

function tick() {
  if (!me) return;
  const gained = syncBoosters(me);
  if (gained > 0) {
    toast(`📦 Nouveau booster disponible${gained > 1 ? ` (+${gained})` : ""} !`);
    if (!ui.opening && !ui.busy) render();
    refreshProfile();   // confirme avec le serveur
  }
  const left = fmtClock(msToNextBooster(me));
  document.querySelectorAll("[data-countdown]").forEach((n) => { n.textContent = left; });
}

/* ---------- Démarrage ---------- */

async function loadCards() {
  if (window.__CARDS__) return window.__CARDS__;
  const res = await fetch("cards.json");
  return (await res.json()).cards;
}

async function start() {
  if (configMissing || !sb) { ui.loading = false; return render(); }

  render();
  try {
    buildCatalog(await loadCards());
  } catch (err) {
    ui.loading = false;
    ui.fatal = "Impossible de charger cards.json : " + err.message;
    return render();
  }

  // L'utilisateur peut avoir été déconnecté depuis un autre onglet
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && me) { me = null; ui.opening = null; closeModal(); render(); }
  });

  try {
    const { data } = await sb.auth.getSession();
    if (data.session) await enterGame();
  } catch (err) {
    ui.fatal = friendlyError(err);
  }
  ui.loading = false;
  render();

  setInterval(tick, 1000);
  // Retour sur l'app (ou depuis un autre appareil) : on se resynchronise avec le serveur
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshProfile({ force: true }); });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !window.__CARDS__) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
  }
}

start();
