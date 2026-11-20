"use strict";

/* =====================================================
   WikiBrand : jeu de cartes à collectionner
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
  { key: "commun",     label: "Commun",     tagline: "Peut mieux faire", color: "#94a3b8", weight: 60,   sell: 5 },
  { key: "peu-commun", label: "Peu commun", tagline: "Encouragements",   color: "#38bdf8", weight: 25,   sell: 10 },
  { key: "rare",       label: "Rare",       tagline: "Bien",             color: "#818cf8", weight: 10,   sell: 25 },
  { key: "epique",     label: "Épique",     tagline: "Très bien",        color: "#c084fc", weight: 4,    sell: 75 },
  { key: "legendaire", label: "Légendaire", tagline: "Félicitations",    color: "#fbbf24", weight: 0.9,  sell: 200 },
  { key: "divin",      label: "Divin",      tagline: "Hors-barème",      color: "#f43f5e", weight: 0.1,  sell: 500 },
];
RARITIES.forEach((r, i) => { r.tier = i; });
const RARITY_BY_KEY = new Map(RARITIES.map((r) => [r.key, r]));

/* ---------- Configuration Supabase ---------- */

// config.js peut définir WIKIBRAND_CONFIG (nouveau nom) ou COLLECTO_CONFIG (ancien nom, toujours accepté)
const CFG = window.WIKIBRAND_CONFIG || window.COLLECTO_CONFIG || {};
// ATTENTION : ces deux valeurs par défaut ne se renomment PAS. Elles servent à reconstruire l'e-mail et le mot de passe
// des comptes déjà créés ; les changer empêcherait tous les joueurs existants de se connecter.
const EMAIL_DOMAIN = CFG.EMAIL_DOMAIN || "collecto.game";
const PIN_PEPPER = CFG.PIN_PEPPER || "-collecto";

const isPlaceholder = (v) => !v || /VOTRE/i.test(v);
const configMissing = isPlaceholder(CFG.SUPABASE_URL) || isPlaceholder(CFG.SUPABASE_ANON_KEY);

// Migration de marque : on recopie l'ancienne session / les anciennes préférences (une seule fois), personne n'est déconnecté
try {
  [["collecto-auth", "wikibrand-auth"], ["collecto-prefs", "wikibrand-prefs"]].forEach(([from, to]) => {
    const v = localStorage.getItem(from);
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
  });
} catch {}

let sb = null;
if (!configMissing && window.supabase) {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "wikibrand-auth" },
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

// Mode testeur : l'affichage du panneau est cosmétique, le serveur revérifie (admin.sql).
const ADMIN_PSEUDOS = ["test"];
const isAdmin = () => !!me && ADMIN_PSEUDOS.includes(me.pseudo.toLowerCase());

function newMkt() {
  return { tab: "daily", daily: null, dailyAt: 0, dailyErr: false, dailyOffset: 0, offers: null, offersAt: 0, offersErr: false, maxOpen: 5, filter: "all", mine: false };
}
const ui = {
  rarity: null,               // filtre de rareté (clé de RARITIES) ou null
  filtersOpen: !!(window.matchMedia && window.matchMedia("(min-width: 768px)").matches),   // tiroir de filtres
  openStage: "tear",          // ouverture d'un booster : tear | reveal | recap
  openIdx: 0,                 // carte courante de la pile
  tq: { mine: "", theirs: "" },   // filtres rapides de la modale d'échange
  sort: { key: "rarity", dir: "desc" },   // rarity | name | obtained
  admin: { open: false, test: false, mode: "luck", rarity: "divin", luck: 50 },   // mode : "force" | "luck"
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
  friendsTab: "friends",      // friends | trades | ranking (sous-onglets de l'onglet Amis)
  visit: null,                // { pseudo, data } : profil d'un ami en cours de visite
  search: { q: "", results: null },
  trade: null,                // brouillon de proposition d'échange
  settings: false,            // page Paramètres ouverte
  achPage: false,             // page Succès ouverte (depuis le Profil)
  boosterTab: "mine",         // mine | shop (sous-onglets de l'onglet Boosters)
  shopTab: "packs",           // packs | cards (Boutique : boosters ou cartes à l'unité)
  market: null,               // { total_players, cards: [{ id, rarete, owners_count, price }] } (get_card_market)
  marketAt: 0, marketErr: false, marketQ: "", marketSort: { key: "price", dir: "asc" }, marketOnlyNew: false,
  mkt: newMkt(),              // Marché : offres du jour + offres entre joueurs
  offerForm: null,            // brouillon de la modale « Nouvelle offre »
  openTier: null,             // palier du booster en cours d'ouverture (visuel du paquet)
};

/* ---------- Préférences locales (enregistrées dans le navigateur) ---------- */

const APP_VERSION = "1.8.0";
const PREFS_KEY = "wikibrand-prefs";
const prefs = { vibrate: true, calm: false };       // calm : réduit les animations
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch {}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }
function applyPrefs() { document.documentElement.classList.toggle("calm", !!prefs.calm); }
applyPrefs();
const vibe = (pattern) => { if (prefs.vibrate && navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} } };

/* ---------- Installation (PWA) ---------- */

let deferredPrompt = null;
const isStandalone = () =>
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();                       // on garde l'événement pour le bouton des Paramètres
  deferredPrompt = e;
  if (ui.settings && me) render();
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  toast("WikiBrand est installé sur ton appareil.");
  if (ui.settings && me) render();
});
async function installApp() {
  if (!deferredPrompt) return;
  const ev = deferredPrompt;
  deferredPrompt = null;
  try { ev.prompt(); await ev.userChoice; } catch (err) { console.warn("[install]", err); }
  render();
}

/* ---------- Utilitaires ---------- */

// checked/selected/open... doivent être des PROPRIÉTÉS du DOM (un attribut ne suit pas l'état réel).
const BOOL_PROPS = new Set(["checked", "selected", "disabled", "open"]);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (BOOL_PROPS.has(k)) node[k] = v !== undefined && v !== null && v !== false;   // "" = présent
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/* ---------- Icônes SVG (currentColor, trait 2 px) ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  booster:   '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  collection:'<rect x="3" y="6" width="12" height="15" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v12"/>',
  friends:   '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  profile:   '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  userplus:  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  coin:      '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11"/><path d="M15 9.2c-.5-.9-1.6-1.4-3-1.4-1.7 0-3 .8-3 2.1s1.3 1.8 3 2.1 3 .8 3 2.1-1.3 2.1-3 2.1c-1.4 0-2.5-.5-3-1.4"/>',
  lock:      '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  swap:      '<path d="M4 8h16"/><path d="m16 4 4 4-4 4"/><path d="M20 16H4"/><path d="m8 12-4 4 4 4"/>',
  crown:     '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 21h14"/>',
  medal:     '<circle cx="12" cy="15" r="6"/><path d="M8.6 10 6 3h4l2 4 2-4h4l-2.6 7"/>',
  trophy:    '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
  star:      '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  card:      '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="m12 8 2.6 4-2.6 4-2.6-4z"/>',
  plus:      '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus:     '<path d="M5 12h14"/>',
  close:     '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  back:      '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  check:     '<path d="m5 12 5 5L20 7"/>',
  chevron:   '<path d="m9 18 6-6-6-6"/>',
  flask:     '<path d="M10 3h4"/><path d="M11 3v6l-6 10a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 19l-6-10V3"/>',
  filter:    '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/>',
  arrowdown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  reset:     '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  alert:     '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  search:    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  share:     '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  shop:      '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  sparkle:   '<path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m6 6 2 2"/><path d="m16 16 2 2"/><path d="m18 6-2 2"/><path d="m8 16-2 2"/>',
};

function icon(name, size = 20) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.setAttribute("class", `ico ico-${name}`);
  s.innerHTML = ICONS[name] || "";
  return s;
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
  if (/already_claimed/.test(msg)) return ui.boosterTab === "market" ? "Offre du jour déjà utilisée." : "Succès déjà réclamé.";
  if (/offer_not_available/.test(msg)) return "Cette offre du jour n'existe plus. Actualise le marché.";
  if (/offer_not_open/.test(msg)) return "Cette offre n'est plus disponible (déjà prise ou annulée).";
  if (/offer_not_found/.test(msg)) return "Offre introuvable.";
  if (/own_offer/.test(msg)) return "Tu ne peux pas accepter ta propre offre.";
  if (/not_your_offer/.test(msg)) return "Ce n'est pas ton offre.";
  if (/too_many_offers/.test(msg)) return "Tu as déjà 5 offres ouvertes. Annule-en une d'abord.";
  if (/invalid_price/.test(msg)) return "Prix invalide.";
  if (/not_unlocked/.test(msg)) return "Ce succès n'est pas encore débloqué.";
  if (/unknown_achievement/.test(msg)) return "Succès inconnu.";
  if (/unauthorized/.test(msg)) return "Action réservée au compte testeur.";
  if (/invalid_rarity/.test(msg)) return "Aucune carte de cette rareté sur le serveur.";
  if (/unknown_card/.test(msg)) return "Cette carte n'existe pas sur le serveur.";
  if (/unknown_tier/.test(msg)) return "Ce booster n'existe pas (SQL shop_v2.sql à exécuter ?).";
  if (/not_enough_abris/.test(msg)) return "Pas assez d'Abri$.";
  if (/no_booster/.test(msg)) return "Plus aucun booster disponible.";
  if (/not_enough_cards/.test(msg)) return "Tu ne possèdes pas assez d'exemplaires de cette carte.";
  if (/no_cards/.test(msg)) return "Aucune carte n'est enregistrée sur le serveur (exécute seed_cards.sql).";
  if (/query_too_short/.test(msg)) return "Tape au moins 2 caractères.";
  if (/player_not_found/.test(msg)) return "Aucun joueur avec ce pseudo.";
  if (/cannot_add_self|cannot_trade_with_self/.test(msg)) return "Tu ne peux pas faire ça avec toi-même.";
  if (/already_friends/.test(msg)) return "Vous êtes déjà amis.";
  if (/request_already_sent/.test(msg)) return "Demande déjà envoyée.";
  if (/too_many_requests/.test(msg)) return "Trop de demandes en attente. Attends des réponses avant d'en envoyer d'autres.";
  if (/request_not_found/.test(msg)) return "Cette demande n'existe plus.";
  if (/not_friends/.test(msg)) return "Vous n'êtes pas amis.";
  if (/same_card/.test(msg)) return "Une même carte ne peut pas être des deux côtés de l'échange.";
  if (/invalid_card_count/.test(msg)) return "Chaque camp doit avoir entre 1 et 5 cartes (ou des Abri$ contre au moins 1 carte).";
  if (/abris_both_sides/.test(msg)) return "Des Abri$ d'un seul côté à la fois.";
  if (/invalid_abris/.test(msg)) return "Montant d'Abri$ invalide.";
  if (/friend_not_enough_abris/.test(msg)) return "Ton ami n'a pas assez d'Abri$ pour cette demande.";
  if (/not_enough_abris/.test(msg)) return "Tu n'as pas assez d'Abri$ pour cette offre.";
  if (/sender_lacks_abris/.test(msg)) return "Échange impossible : ton ami n'a plus assez d'Abri$.";
  if (/you_lack_abris/.test(msg)) return "Échange impossible : tu n'as plus assez d'Abri$.";
  if (/card_not_owned/.test(msg)) return "Tu ne possèdes plus toutes les cartes que tu proposes.";
  if (/friend_lacks_card/.test(msg)) return "Ton ami ne possède plus toutes les cartes demandées.";
  if (/trade_already_proposed/.test(msg)) return "Tu as déjà proposé exactement cet échange.";
  if (/too_many_trades/.test(msg)) return "Trop de propositions en attente. Attends des réponses avant d'en envoyer d'autres.";
  if (/trade_not_found/.test(msg)) return "Cette proposition n'existe plus.";
  if (/trade_not_pending/.test(msg)) return "Cette proposition a déjà reçu une réponse.";
  if (/sender_lacks_card/.test(msg)) return "Échange impossible : ton ami n'a plus toutes les cartes proposées.";
  if (/you_lack_card/.test(msg)) return "Échange impossible : tu n'as plus toutes les cartes demandées.";
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
  me = { pseudo: j.pseudo, abris: j.abris, boosters: j.boosters, owned: j.owned || {}, obtainedAt: j.obtained_at || {}, lastTick: j.last_tick_ms };
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

// "Capacité : 500 élèves | Bruit : 85 dB"  ->  [["Capacité","500 élèves"],["Bruit","85 dB"]]
// (un objet {clé: valeur} reste accepté)
function parseStats(s) {
  if (!s) return [];
  if (typeof s === "object") return Object.entries(s);
  return String(s).split("|").map((part) => {
    const i = part.indexOf(":");
    return i < 0 ? ["", part.trim()] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([, v]) => v);
}

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
    stats: parseStats(raw.statistiques),
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

function collectionStats(cat = null, sub = null, rarity = null) {
  const cards = catalog.filter((c) => (!cat || c.categorie === cat) && (!sub || c.sous === sub) && (!rarity || c.rarity.key === rarity));
  const owned = cards.filter((c) => (me.owned[c.id] || 0) > 0).length;
  return { owned, total: cards.length };
}

const fmtStats = (s) => `(${s.owned}/${s.total})`;

/* ---------- Tri de la collection ---------- */

const SORTS = {
  rarity:   { label: "Rareté",    dir: "desc", hint: { desc: "Divin→Commun", asc: "Commun→Divin" } },
  name:     { label: "Nom",       dir: "asc",  hint: { asc: "A→Z", desc: "Z→A" } },
  obtained: { label: "Obtention", dir: "desc", hint: { desc: "Récentes", asc: "Anciennes" } },
};

function sortCards(cards) {
  const { key, dir } = ui.sort;
  const k = dir === "asc" ? 1 : -1;                       // sens demandé, pour la clé choisie
  const byName = (a, b) => a.titre.localeCompare(b.titre, "fr");
  const when = (c) => (me.owned[c.id] || 0) > 0 ? (me.obtainedAt[c.id] || 0) : null;
  return [...cards].sort((a, b) => {
    if (key === "name") return k * byName(a, b);
    if (key === "obtained") {
      const x = when(a), y = when(b);
      if (x === null || y === null) {                     // non possédées : toujours en fin de liste
        if (x === y) return b.rarity.tier - a.rarity.tier || byName(a, b);
        return x === null ? 1 : -1;
      }
      return k * (x - y) || byName(a, b);
    }
    return k * (a.rarity.tier - b.rarity.tier) || byName(a, b);   // rareté, puis nom A→Z
  });
}

/* ---------- Actions (toutes passent par le serveur) ---------- */

// Ouverture : de la moins rare à la plus rare (la tension monte). On mélange d'abord, puis on trie
// (Array.sort est stable) : l'ordre reste aléatoire entre cartes de même rareté, et isNew suit sa carte.
function makeOpening(cards) {
  const items = cards.map((c) => ({ card: cardFromServer(c.id, c.rarete), isNew: !!c.is_new, revealed: false }));
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.sort((a, b) => a.card.rarity.tier - b.card.rarity.tier);
}

async function doOpenBooster() {
  const test = isAdmin() && ui.admin.test;
  if (ui.busy || !me || (me.boosters <= 0 && !test)) return;
  ui.busy = "open";
  render();
  try {
    const j = test
      ? await profileCall("admin_open_booster", ui.admin.mode === "force"
          ? { p_force_rarity: ui.admin.rarity, p_luck: 1 }
          : { p_force_rarity: null, p_luck: ui.admin.luck })
      : await profileCall("open_booster");
    ui.opening = makeOpening(j.cards);
    ui.openTier = null;
    ui.openStage = "tear";
    ui.openIdx = 0;
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  render();
}

/* ---------- Boutique : achat de boosters en Abri$ ---------- */

// Doit correspondre à private.shop_tier (shop_and_settings.sql + shop_v2.sql). Le serveur recalcule tout : prix et tirage.
// count = cartes du paquet ; guarantee = rareté minimale garantie sur au moins 1 carte.
const ULTRA_MULT = { rare: 3, epique: 6, legendaire: 8, divin: 5 };
const SHOP = [
  { id: "standard", name: "Standard", price: 150,  count: 5, mult: {},                                                tag: "Chances classiques" },
  { id: "super",    name: "Super",    price: 400,  count: 5, mult: { rare: 2.5, epique: 3, legendaire: 3, divin: 2 }, tag: "Meilleures chances" },
  { id: "ultra",    name: "Ultra",    price: 1000, count: 5, mult: ULTRA_MULT,                                        tag: "Chances très élevées" },
  { id: "garanti_epique",     name: "Épique garanti",     price: 2000, count: 3, guarantee: "epique",     mult: ULTRA_MULT, tag: "Chances très élevées" },
  { id: "garanti_legendaire", name: "Légendaire garanti", price: 5000, count: 3, guarantee: "legendaire", mult: ULTRA_MULT, tag: "Chances très élevées" },
];
const packCount = (tierId) => (SHOP.find((t) => t.id === tierId) || {}).count || BOOSTER_SIZE;
const shopBadge = (t) => t.guarantee ? `${t.count} cartes · ${RARITY_BY_KEY.get(t.guarantee).label} garantie` : `${t.count} cartes`;

// Probabilités effectives d'un palier (poids x multiplicateur, ramenés à 100 %)
function shopOdds(tier) {
  const active = RARITIES.filter((r) => (byRarity.get(r.key) || []).length);
  const w = (r) => r.weight * (tier.mult[r.key] || 1);
  const total = active.reduce((a, r) => a + w(r), 0) || 1;
  return active.map((r) => ({ r, pct: (w(r) / total) * 100, boost: tier.mult[r.key] || 1 }));
}
const fmtPct = (x) => `${x.toLocaleString("fr-FR", { maximumFractionDigits: x < 1 ? 2 : 1 })} %`;

async function buyBooster(id) {
  const tier = SHOP.find((t) => t.id === id);
  if (!tier || ui.busy || !me) return;
  if (me.abris < tier.price) return toast(`Il te manque ${money(tier.price - me.abris)}.`);
  ui.busy = "buy";
  render();
  try {
    const seq = ++seqIssued;
    const j = await rpc("buy_booster", { p_tier: id });
    if (seq > seqApplied) { seqApplied = seq; applyProfile(j.profile); }
    ui.opening = makeOpening(j.cards);
    ui.openTier = id;
    ui.openStage = "tear";
    ui.openIdx = 0;
    ui.boosterTab = "mine";
  } catch (err) {
    toast(/not_enough_abris/.test(String(err && err.message)) ? "Pas assez d'Abri$ pour ce booster." : friendlyError(err));
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
  ui.settings = false;
  ui.achPage = false;
  ui.mkt = newMkt(); ui.offerForm = null;
  ui.boosterTab = "mine";
  ui.authMode = null;
  ui.visit = null;
  ui.friendsTab = "friends";
  ui.search = { q: "", results: null };
  social = emptySocial();
  achievements = null;
  board = null;
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
  else if (j.gained > 0) toast(`+${j.gained} booster${j.gained > 1 ? "s" : ""} reçu${j.gained > 1 ? "s" : ""} pendant ton absence`);
  refreshSocial();
}

/* ---------- Habillage : avatar, paquet de booster, inclinaison 3D ---------- */

// Pastille ronde avec l'initiale du pseudo ; la teinte dépend du pseudo (toujours la même pour un joueur)
function avatar(pseudo, big = false) {
  let h = 0;
  for (const ch of String(pseudo)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const node = el("span", { class: "avatar" + (big ? " big" : ""), "aria-hidden": "true" },
    (String(pseudo).trim()[0] || "?").toUpperCase());
  node.style.setProperty("--h", String(h));
  return node;
}

function makePack({ empty = false, test = false, big = false, tear = false, tier = null } = {}) {
  return el("div", {
    class: "booster-pack" + (empty ? " empty" : "") + (test ? " test" : "") + (big ? " big" : "") + (tier ? ` tier-${tier}` : ""),
    role: "img", "aria-label": empty ? "Booster verrouillé : aucun booster en stock" : "Booster WikiBrand",
  },
    tear
      // languette supérieure en deux morceaux : la partie encore collée (att) et la partie déjà déchirée (flap)
      ? el("div", { class: "bp-top" },
          el("i", { class: "bp-seal top bp-strip att" }),
          el("i", { class: "bp-seal top bp-strip flap" }),
          el("div", { class: "bp-cut" }))
      : el("div", { class: "bp-seal top" }),
    tear ? el("i", { class: "bp-seal bp-lip" }) : null,
    el("div", { class: "bp-body" },
      el("div", { class: "bp-emblem" }, icon("card", 30)),
      el("div", { class: "bp-title" }, "WIKIBRAND"),
      el("div", { class: "bp-sub" }, `${packCount(tier)} CARTES`)),
    el("div", { class: "bp-seal bottom" }),
    el("i", { class: "bp-shine" }),
    empty ? el("span", { class: "bp-lock" }, icon("lock", 26)) : null
  );
}

function boosterPack(testMode) {
  return el("div", { class: "pack-stage" }, makePack({ empty: me.boosters === 0 && !testMode, test: testMode }));
}

// Légère inclinaison 3D au doigt / à la souris + reflet qui suit le pointeur
function enableTilt(card) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const reset = () => {
    card.classList.remove("tilting");
    card.style.removeProperty("--rx"); card.style.removeProperty("--ry");
  };
  const move = (e) => {
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    card.classList.add("tilting");
    card.style.setProperty("--ry", `${((px - 0.5) * 22).toFixed(1)}deg`);
    card.style.setProperty("--rx", `${(-(py - 0.5) * 22).toFixed(1)}deg`);
    card.style.setProperty("--mx", `${(px * 100).toFixed(0)}%`);
    card.style.setProperty("--my", `${(py * 100).toFixed(0)}%`);
  };
  card.addEventListener("pointermove", move);
  card.addEventListener("pointerdown", move);
  ["pointerleave", "pointerup", "pointercancel"].forEach((t) => card.addEventListener(t, reset));
}

function emptyState(ico, title, text) {
  return el("div", { class: "empty-state" },
    el("span", { class: "empty-ico" }, icon(ico, 26)),
    el("strong", {}, title),
    text ? el("p", { class: "muted small" }, text) : null);
}

/* ---------- Interface : carte ---------- */

function cardArt(card) {
  const art = el("div", { class: "g-art" });
  const fallback = () => el("div", { class: "g-fallback" }, icon("card", 34));
  if (card.image) {
    const img = el("img", { src: card.image, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(fallback()));
    art.append(img);
  } else {
    art.append(fallback());
  }
  return art;
}

function cardFace(card, { big = false, stats = false } = {}) {
  const r = card.rarity;
  const node = el("div", { class: "gcard" + (big ? " big" : ""), "data-tier": String(r.tier) },
    cardArt(card),
    el("div", { class: "g-name" }, card.titre),
    stats && card.stats.length
      ? el("ul", { class: "g-stats" }, card.stats.slice(0, 2).map(([k, v]) =>
          el("li", {}, k ? el("span", {}, k) : null, el("b", {}, fmtNum(v)))))
      : null,
    el("div", { class: "g-meta" }, r.label)
  );
  node.style.setProperty("--rc", r.color);
  return node;
}

/* ---------- Interface : fiche d'une carte (modale) ---------- */

function showCard(card) {
  const owned = (me && me.owned[card.id]) > 0;
  ui.modal = { id: card.id, confirm: false, buy: !owned };       // carte non possédée : fiche verrouillée + achat direct
  renderModal();
  if (!owned) loadMarket();
}

// Fiche d'une carte non possédée : silhouette, nom, rareté, prix (l'illustration reste cachée)
function renderBuyModal(card) {
  const r = card.rarity;
  const x = marketEntry(card.id);
  const afford = x && me.abris >= x.price;
  const label = !x ? (ui.marketErr ? "Prix indisponible" : "Calcul du prix…")
    : ui.busy === "card" ? "Achat…"
    : afford ? `Acheter cette carte · ${money(x.price)}` : `Il te manque ${money(x.price - me.abris)}`;
  const box = el("div", { class: "modal-box", role: "dialog", "aria-label": card.titre },
    el("button", { class: "modal-x", type: "button", "aria-label": "Fermer", onclick: closeModal }, icon("close", 20)),
    el("div", { class: "tile card-locked locked-big" }, cardFace(card), el("span", { class: "lock-badge" }, icon("lock", 22))),
    el("h3", { class: "center buy-name" }, card.titre),
    el("p", { class: "tagline" }, `${r.label} · ${r.tagline}`),
    el("p", { class: "muted small center" }, `${card.categorie}${card.sous ? " › " + card.sous : ""}`),
    x ? el("p", { class: "muted small center" }, ownersText(x)) : null,
    el("button", { class: "primary", type: "button", disabled: x && afford && !ui.busy ? null : "", onclick: () => buyCard(card) }, label),
    el("p", { class: "muted small center" }, "Prix dynamique, recalculé par le serveur au moment de l'achat."),
    el("button", { class: "secondary", onclick: closeModal }, "Fermer")
  );
  box.style.setProperty("--rc", r.color);
  $modal.replaceChildren(
    el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } }, box)
  );
}

function closeModal() {
  ui.modal = null;
  ui.offerForm = null;
  ui.trade = null;
  $modal.replaceChildren();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function renderModal(force) {
  if (ui.offerForm && me) return renderOfferModal(force);
  if (!ui.modal || !me) return closeModal();
  const card = byId.get(ui.modal.id);
  const count = card ? me.owned[card.id] || 0 : 0;
  if (!card) return closeModal();
  if (!count) return ui.modal.buy ? renderBuyModal(card) : closeModal();

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
    el("button", { class: "modal-x", type: "button", "aria-label": "Fermer", onclick: closeModal }, icon("close", 20)),
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
  enableTilt(box.querySelector(".gcard.big"));

  $modal.replaceChildren(
    el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } }, box)
  );
}

/* ---------- Interface : écrans sans profil ---------- */

function viewMessage(title, ...lines) {
  return el("section", { class: "auth" },
    el("div", { class: "pack" }, icon("card", 72)),
    el("h1", {}, title),
    lines.map((l) => (typeof l === "string" ? el("p", { class: "muted center" }, l) : l))
  );
}

function viewSetup() {
  return viewMessage("WikiBrand",
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
    el("div", { class: "pack" }, icon("card", 72)),
    el("h1", {}, "WikiBrand"),
    el("p", { class: "muted center" }, isCreate ? "Crée ton profil pour commencer ta collection." : "Connecte-toi pour retrouver ta collection."),
    form,
    switcher
  );
}

/* ---------- Interface : structure ---------- */

function header() {
  return el("header", { class: "topbar" },
    el("strong", { class: "brand" }, icon("card", 20), el("span", { class: "brand-name" }, "WikiBrand")),
    el("div", { class: "pills" },
      el("span", { class: "pill", title: "Boosters en stock" }, icon("booster", 16), el("span", { "data-stock": "" }, `${me.boosters}/${MAX_BOOSTERS}`)),
      el("span", { class: "pill gold", title: "Ton solde" }, icon("coin", 16), money(me.abris)),
      el("button", {
        class: "gear-btn" + (ui.settings ? " active" : ""), type: "button", "aria-label": "Paramètres",
        onclick: () => { ui.settings = true; ui.achPage = false; ui.visit = null; render(); },
      }, icon("settings", 18))
    )
  );
}

function nav() {
  const tab = (id, ico, label, badge = 0) =>
    el("button", {
      class: "nav-btn" + (ui.tab === id ? " active" : ""),
      onclick: () => {
        ui.tab = id;
        ui.settings = false;
        ui.achPage = false;
        ui.visit = null;
        ui.confirmReset = false;
        render();
        window.scrollTo(0, 0);
        if (id === "friends") { refreshSocial(); if (ui.friendsTab === "ranking") loadBoard(); }
        if (id === "profile") loadAchievements();
      },
    },
      el("span", { class: "nav-ico" }, icon(ico, 22)),
      el("span", {}, label),
      badge > 0 ? el("span", { class: "nav-badge" }, String(badge)) : null
    );
  return el("nav", { class: "nav" },
    tab("boosters", "booster", "Boosters"),
    tab("collection", "collection", "Collection"),
    tab("friends", "friends", "Amis", socialBadge()),
    tab("profile", "profile", "Profil")
  );
}

// Identifie « l'écran » affiché : tant qu'il ne change pas, un nouveau rendu garde la position de défilement
let lastViewKey = "";
const viewKey = () => [ui.settings, ui.achPage, ui.tab, ui.boosterTab, ui.shopTab, ui.mkt.tab, ui.friendsTab, !!ui.visit, ui.opening ? "o" + ui.openStage : ""].join("|");

function render() {
  if (configMissing || !sb) return $app.replaceChildren(viewSetup());
  if (ui.fatal) return $app.replaceChildren(viewFatal());
  if (ui.loading) return $app.replaceChildren(el("p", { class: "muted center loading" }, "Chargement…"));
  if (!me) { lastViewKey = ""; return $app.replaceChildren(viewAuth()); }
  const y = window.scrollY;
  const key = viewKey();
  const view = ui.settings ? viewSettings()
    : ui.achPage ? viewAchievements()
    : ui.tab === "boosters" ? viewBoosters()
    : ui.tab === "collection" ? viewCollection()
    : ui.tab === "friends" ? viewFriends()
    : viewProfile();
  $app.replaceChildren(header(), view, nav());
  // Remplacer le contenu fait perdre la position de défilement : on la restaure (même écran) ou on remonte (autre écran)
  window.scrollTo(0, key === lastViewKey ? y : 0);
  lastViewKey = key;
  measureNav();
}

// Hauteur réelle de la barre du bas (safe-area comprise) -> marge basse exacte du contenu (voir #app dans style.css)
function measureNav() {
  const n = document.querySelector(".nav");
  if (n) document.documentElement.style.setProperty("--nav-h", `${n.offsetHeight}px`);
}
window.addEventListener("resize", measureNav);

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

  const testMode = isAdmin() && ui.admin.test;
  const canOpen = (me.boosters > 0 || testMode) && !ui.busy;

  const segBtn = (id, label, ico) => el("button", {
    class: ui.boosterTab === id ? "active" : "", type: "button",
    onclick: () => { ui.boosterTab = id; render(); if (id === "market") loadMarketHub(true); },
  }, icon(ico, 16), label);
  const tabs = el("div", { class: "seg tabs3" }, segBtn("mine", "Boosters", "booster"), segBtn("shop", "Boutique", "shop"), segBtn("market", "Marché", "swap"));
  if (ui.boosterTab === "shop") return el("section", { class: "view" }, tabs, viewShop());
  if (ui.boosterTab === "market") return el("section", { class: "view" }, tabs, viewMarketHub());

  return el("section", { class: "view" },
    tabs,
    boosterPack(testMode),
    pips,
    el("p", { class: "center stock-line" }, `${me.boosters} / ${MAX_BOOSTERS} boosters`),
    timer,
    el("button", {
      class: "primary", disabled: canOpen ? null : "",
      onclick: doOpenBooster,
    }, ui.busy === "open" ? "Ouverture…" : testMode ? `Booster de test (${BOOSTER_SIZE} cartes)` : me.boosters > 0 ? `Ouvrir un booster (${BOOSTER_SIZE} cartes)` : "Aucun booster disponible"),
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

/* ---------- Interface : boutique ---------- */

function viewShop() {
  const sub = (id, label, ico) => el("button", {
    class: ui.shopTab === id ? "active" : "", type: "button",
    onclick: () => { ui.shopTab = id; render(); if (id === "cards") loadMarket(); },
  }, icon(ico, 15), label);
  const subTabs = el("div", { class: "seg sub" }, sub("packs", "Boosters", "booster"), sub("cards", "Cartes à l'unité", "card"));
  return el("div", {}, subTabs, ui.shopTab === "cards" ? viewMarket() : viewPacks());
}

function viewPacks() {
  const cards = SHOP.map((t) => {
    const odds = shopOdds(t).filter((o) => o.r.tier >= 2);          // rare et au-dessus : c'est là que ça change
    const can = me.abris >= t.price;
    const rows = odds.map(({ r, pct, boost }) => {
      const row = el("div", { class: "shop-odd" },
        el("i", { class: "dot" }),
        el("span", { class: "shop-odd-name" }, r.label),
        boost > 1 ? el("em", { class: "boost" }, `×${boost.toLocaleString("fr-FR")}`) : null,
        el("b", {}, fmtPct(pct)));
      row.style.setProperty("--rc", r.color);
      return row;
    });
    const g = t.guarantee ? RARITY_BY_KEY.get(t.guarantee) : null;
    return el("article", { class: `shop-card tier-${t.id}` },
      el("div", { class: "shop-pack" }, makePack({ tier: t.id })),
      el("div", { class: "shop-info" },
        el("div", { class: "shop-head" },
          el("h3", {}, `Booster ${t.name}`),
          el("span", { class: "shop-price" }, icon("coin", 14), money(t.price))),
        g
          ? el("p", { class: "shop-guar" }, icon("star", 13), shopBadge(t))
          : el("p", { class: "muted small shop-tag" }, `${t.tag} · ${shopBadge(t)}`),
        g ? el("p", { class: "muted small shop-tag" }, `1 carte ${g.label} ou mieux assurée, les ${t.count - 1} autres aux chances Ultra`) : null,
        el("div", { class: "shop-odds" }, rows),
        el("button", {
          class: "primary shop-buy", type: "button", disabled: can && !ui.busy ? null : "",
          onclick: () => buyBooster(t.id),
        }, ui.busy === "buy" ? "Achat…" : can ? `Acheter · ${money(t.price)}` : `Il te manque ${money(t.price - me.abris)}`)));
  });
  return el("div", {},
    el("p", { class: "muted small" }, "Les boosters de la boutique ne consomment pas ton stock : ils s'ouvrent tout de suite."),
    el("div", { class: "shop-list" }, cards));
}

/* ---------- Boutique : cartes à l'unité (prix dynamique selon la rareté chez les joueurs) ---------- */

let marketBusy = false;
async function loadMarket(force = false) {
  if (marketBusy || !me) return;
  if (!force && ui.market && Date.now() - ui.marketAt < 30000) return;
  marketBusy = true;
  try {
    ui.market = await rpc("get_card_market");
    ui.marketAt = Date.now(); ui.marketErr = false;
  } catch (e) {
    console.warn("get_card_market:", e); ui.marketErr = true;
  }
  marketBusy = false;
  const host = document.querySelector(".mk-list");
  if (host) fillMarketList(host);                      // pas de render() : on garde le champ de recherche et le scroll
  if (ui.modal && ui.modal.buy) renderModal();
}

const marketEntry = (id) => (ui.market && ui.market.cards.find((x) => x.id === id)) || null;
function ownersText(x, short = false) {
  const total = (ui.market && ui.market.total_players) || 1;
  if (!x.owners_count) return "Détenue par personne";
  const pct = (x.owners_count / total) * 100;
  return `Détenue par ${pct < 1 ? "< 1" : Math.round(pct).toLocaleString("fr-FR")} %${short ? "" : " des joueurs"}`;
}
const plain = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function fillMarketList(host) {
  if (!ui.market) {
    host.replaceChildren(ui.marketErr
      ? el("div", { class: "empty-grid center" }, el("p", { class: "muted small" }, "Impossible de charger les prix (SQL market_cards.sql exécuté ?)."),
          el("button", { class: "secondary", type: "button", onclick: () => { ui.marketErr = false; fillMarketList(host); loadMarket(true); } }, "Réessayer"))
      : el("p", { class: "muted small center loading-line" }, "Calcul des prix…"));
    return;
  }
  const q = plain(ui.marketQ.trim());
  const k = ui.marketSort.dir === "asc" ? 1 : -1;
  const rows = ui.market.cards
    .map((x) => ({ x, card: byId.get(x.id) }))
    .filter((e) => e.card && (!q || plain(e.card.titre).includes(q)) && (!ui.marketOnlyNew || !(me.owned[e.x.id] > 0)))
    .sort((a, b) => ui.marketSort.key === "price"
      ? k * (a.x.price - b.x.price) || a.card.titre.localeCompare(b.card.titre, "fr")
      : k * (a.card.rarity.tier - b.card.rarity.tier) || a.x.price - b.x.price);
  if (!rows.length) { host.replaceChildren(el("p", { class: "muted small empty-grid center" }, "Aucune carte ne correspond.")); return; }
  host.replaceChildren(...rows.map(({ x, card }) => {
    const own = me.owned[x.id] || 0;
    const row = el("button", { class: "mk-row", type: "button", onclick: () => showCard(card) },
      el("i", { class: "dot" }),
      el("span", { class: "mk-main" },
        el("strong", {}, card.titre),
        el("small", { class: "muted" }, `${card.rarity.label} · ${ownersText(x, true)}`)),
      el("span", { class: "mk-side" },
        el("em", { class: "mk-own" + (own ? " has" : "") }, own ? `Déjà possédée ×${own}` : "Nouvelle"),
        el("b", { class: "mk-price" + (me.abris < x.price ? " no" : "") }, icon("coin", 12), money(x.price))));
    row.style.setProperty("--rc", card.rarity.color);
    return row;
  }));
}

function viewMarket() {
  const host = el("div", { class: "mk-list" });
  const search = el("input", {
    class: "mk-search", type: "search", placeholder: "Rechercher une carte", value: ui.marketQ,
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Rechercher une carte",
  });
  search.addEventListener("input", () => { ui.marketQ = search.value; fillMarketList(host); });
  const pill = (key, label) => {
    const active = ui.marketSort.key === key;
    const dir = active ? ui.marketSort.dir : "asc";
    return el("button", {
      class: "sort-pill" + (active ? ` active ${dir}` : ""), type: "button", "aria-pressed": active ? "true" : "false",
      onclick: () => { ui.marketSort = active ? { key, dir: dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }; render(); },
    }, label, active ? icon("arrowdown", 14) : null);
  };
  const only = el("button", {
    class: "chip" + (ui.marketOnlyNew ? " active" : ""), type: "button", "aria-pressed": ui.marketOnlyNew ? "true" : "false",
    onclick: () => { ui.marketOnlyNew = !ui.marketOnlyNew; render(); },
  }, "Non possédées");
  fillMarketList(host);
  if (!ui.market) loadMarket(true);
  return el("div", { class: "market" },
    el("p", { class: "muted small" }, "Achète une carte précise, à prix élevé : moins elle est détenue par les joueurs, plus elle coûte cher."),
    search,
    el("div", { class: "mk-tools" }, el("div", { class: "sort-pills" }, pill("price", "Prix"), pill("rarity", "Rareté")), only),
    host);
}

async function buyCard(card) {
  const x = marketEntry(card.id);
  if (!x || ui.busy || !me) return;
  if (me.abris < x.price) return toast(`Il te manque ${money(x.price - me.abris)}.`);
  ui.busy = "card";
  renderModal();
  try {
    const seq = ++seqIssued;
    const j = await rpc("buy_card", { p_card_id: card.id });
    if (seq > seqApplied) { seqApplied = seq; applyProfile(j.profile); }
    vibe(30);
    toast(j.is_new ? `Nouvelle carte : ${card.titre} · −${money(j.price)}` : `${card.titre} ×${me.owned[card.id] || 1} · −${money(j.price)}`);
    ui.modal = { id: card.id, confirm: false };
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  ui.marketAt = 0; loadMarket(true);                    // les prix ont bougé : on les recharge
  render();
  if (ui.modal) renderModal();
}

/* ---------- Marché : offres du jour + offres entre joueurs (market_v2.sql) ---------- */

const onMarketView = () => me && ui.tab === "boosters" && ui.boosterTab === "market" && !ui.settings && !ui.achPage && !ui.opening;
let dailyBusy = false, offersBusy = false;

async function loadDaily(force = false) {
  if (dailyBusy || !me) return;
  if (!force && ui.mkt.daily && Date.now() - ui.mkt.dailyAt < 30000) return;
  dailyBusy = true;
  try {
    const d = await rpc("get_daily_market");
    ui.mkt.daily = d; ui.mkt.dailyAt = Date.now(); ui.mkt.dailyErr = false;
    ui.mkt.dailyOffset = d.server_now_ms - Date.now();
  } catch (e) { console.warn("get_daily_market:", e); ui.mkt.dailyErr = true; }
  dailyBusy = false;
  if (onMarketView()) render();
}
async function loadOffers(force = false) {
  if (offersBusy || !me) return;
  if (!force && ui.mkt.offers && Date.now() - ui.mkt.offersAt < 15000) return;
  offersBusy = true;
  try {
    const d = await rpc("list_player_offers");
    ui.mkt.offers = d.offers || []; ui.mkt.maxOpen = d.max_open || 5; ui.mkt.offersAt = Date.now(); ui.mkt.offersErr = false;
  } catch (e) { console.warn("list_player_offers:", e); ui.mkt.offersErr = true; }
  offersBusy = false;
  if (onMarketView()) render();
  if (ui.offerForm) renderModal(true);
}
function loadMarketHub(force = false) {
  if (ui.mkt.tab === "daily") loadDaily(force); else loadOffers(force);
}

// cartes que j'ai déjà mises en vente (elles ne sont plus disponibles pour une autre offre)
const committedCards = (id) => (ui.mkt.offers || []).filter((o) => o.mine && o.side === "sell" && o.card_id === id).length;
const freeCopies = (id) => Math.max(0, ((me && me.owned[id]) || 0) - committedCards(id));
const myOpenOffers = () => (ui.mkt.offers || []).filter((o) => o.mine);

function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const dailyLeftMs = () => ui.mkt.daily ? ui.mkt.daily.next_ms - (Date.now() + (ui.mkt.dailyOffset || 0)) : 0;
let dailyReloadAt = 0;
function tickDaily() {
  const nodes = document.querySelectorAll("[data-daycount]");
  if (!nodes.length || !ui.mkt.daily) return;
  const left = dailyLeftMs();
  nodes.forEach((n) => { n.textContent = fmtLeft(left); });
  if (left <= 0 && Date.now() - dailyReloadAt > 5000) { dailyReloadAt = Date.now(); loadDaily(true); }
}

function viewMarketHub() {
  const sub = (id, label, ico) => el("button", {
    class: ui.mkt.tab === id ? "active" : "", type: "button",
    onclick: () => { ui.mkt.tab = id; render(); loadMarketHub(); },
  }, icon(ico, 15), label);
  const subTabs = el("div", { class: "seg sub" }, sub("daily", "Offres du jour", "star"), sub("players", "Entre joueurs", "friends"));
  if (ui.mkt.tab === "daily") { if (!ui.mkt.daily && !ui.mkt.dailyErr) loadDaily(true); }
  else if (!ui.mkt.offers && !ui.mkt.offersErr) loadOffers(true);
  return el("div", { class: "mkt" }, subTabs, ui.mkt.tab === "daily" ? viewDaily() : viewPlayerOffers());
}

function mktError(text, retry) {
  return el("div", { class: "empty-grid center" }, el("p", { class: "muted small" }, text),
    el("button", { class: "secondary", type: "button", onclick: retry }, "Réessayer"));
}

/* ----- offres du jour ----- */
function viewDaily() {
  const d = ui.mkt.daily;
  if (!d) {
    return ui.mkt.dailyErr
      ? mktError("Impossible de charger les offres du jour (SQL market_v2.sql exécuté ?).", () => { ui.mkt.dailyErr = false; render(); loadDaily(true); })
      : el("p", { class: "muted center small loading-line" }, "Chargement des offres…");
  }
  const row = (o) => {
    const card = byId.get(o.card_id); if (!card) return null;
    const buy = o.kind === "buy";
    const own = (me.owned[o.card_id] || 0);
    const can = buy ? me.abris >= o.price : freeCopies(o.card_id) >= 1;
    const label = o.claimed ? "Déjà pris" : buy ? (can ? "Acheter" : "Solde insuffisant") : (can ? "Vendre" : "Tu n'en as pas");
    const r = el("div", { class: "mk-row mkt-deal" + (o.claimed ? " is-done" : "") },
      el("i", { class: "dot" }),
      el("span", { class: "mk-main" },
        el("strong", {}, card.titre),
        el("small", { class: "muted" }, `${card.rarity.label} · ${own ? `tu en as ×${own}` : "tu ne l'as pas"}`),
        el("small", { class: "muted" }, buy ? `Prix normal ${money(o.base_price)}` : `Valeur marché ${money(o.base_price)}`)),
      el("span", { class: "mk-side" },
        el("b", { class: "mk-price" + (buy ? "" : " gain") }, icon("coin", 12), (buy ? "" : "+") + money(o.price)),
        el("button", {
          class: (o.claimed ? "secondary" : "primary") + " mkt-btn", type: "button",
          disabled: o.claimed || !can || ui.busy ? "" : null, onclick: () => claimDaily(o),
        }, o.claimed ? [icon("check", 13), label] : label)));
    r.style.setProperty("--rc", card.rarity.color);
    return r;
  };
  const buys = d.offers.filter((o) => o.kind === "buy"), sells = d.offers.filter((o) => o.kind === "sell");
  return el("div", {},
    el("div", { class: "mkt-timer" }, icon("reset", 15), el("span", {}, "Nouvelles offres dans "),
      el("strong", { "data-daycount": "" }, fmtLeft(dailyLeftMs()))),
    el("h3", { class: "mkt-h" }, "À acheter", el("small", { class: "muted" }, "environ −25 % sur le prix normal")),
    el("div", { class: "mk-list" }, buys.map(row)),
    el("h3", { class: "mkt-h" }, "Le marché te rachète", el("small", { class: "muted" }, "tarif de reprise garanti")),
    el("div", { class: "mk-list" }, sells.map(row)),
    el("p", { class: "muted small center mkt-foot" }, "Chaque offre est utilisable une fois par jour et par joueur. Les prix suivent la rareté des cartes chez les joueurs."));
}

async function claimDaily(o) {
  if (ui.busy || !me) return;
  const card = byId.get(o.card_id);
  ui.busy = "daily"; render();
  try {
    const seq = ++seqIssued;
    const j = await rpc("claim_daily_offer", { p_kind: o.kind, p_card_id: o.card_id });
    if (seq > seqApplied) { seqApplied = seq; applyProfile(j.profile); }
    vibe(30);
    toast(o.kind === "buy" ? `${card.titre} acheté · −${money(j.price)}` : `${card.titre} repris · +${money(j.price)}`);
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  ui.market = null; ui.marketAt = 0;                      // les prix ont bougé
  await loadDaily(true); render();
}

/* ----- offres entre joueurs ----- */
function viewPlayerOffers() {
  const all = ui.mkt.offers;
  const newBtn = el("button", {
    class: "primary with-ico mkt-new", type: "button",
    onclick: () => { ui.offerForm = { side: "sell", card: "", price: "" }; renderModal(true); loadMarket(); },
  }, icon("plus", 16), "Nouvelle offre");
  if (!all) {
    return el("div", {}, newBtn, ui.mkt.offersErr
      ? mktError("Impossible de charger les offres (SQL market_v2.sql exécuté ?).", () => { ui.mkt.offersErr = false; render(); loadOffers(true); })
      : el("p", { class: "muted center small loading-line" }, "Chargement des offres…"));
  }
  const f = ui.mkt.filter;
  const chip = (id, label) => el("button", {
    class: "chip" + (f === id ? " active" : ""), type: "button", "aria-pressed": f === id ? "true" : "false",
    onclick: () => { ui.mkt.filter = id; render(); },
  }, label);
  const mineChip = el("button", {
    class: "chip" + (ui.mkt.mine ? " active" : ""), type: "button", "aria-pressed": ui.mkt.mine ? "true" : "false",
    onclick: () => { ui.mkt.mine = !ui.mkt.mine; render(); },
  }, `Mes offres (${myOpenOffers().length}/${ui.mkt.maxOpen})`);
  const rows = all
    .filter((o) => (f === "all" || o.side === f) && (!ui.mkt.mine || o.mine))
    .map((o) => {
      const card = byId.get(o.card_id); if (!card) return null;
      const sells = o.side === "sell";
      let action;
      if (o.mine) {
        action = el("button", { class: "secondary mkt-btn", type: "button", disabled: ui.busy ? "" : null, onclick: () => cancelOffer(o) }, "Annuler");
      } else if (sells) {
        const can = me.abris >= o.price;
        action = el("button", { class: "primary mkt-btn", type: "button", disabled: can && !ui.busy ? null : "", onclick: () => acceptOffer(o) },
          can ? "Acheter" : "Solde insuffisant");
      } else {
        const can = freeCopies(o.card_id) >= 1;
        action = el("button", { class: "primary mkt-btn", type: "button", disabled: can && !ui.busy ? null : "", onclick: () => acceptOffer(o) },
          can ? "Vendre" : "Tu n'en as pas");
      }
      const r = el("div", { class: "mk-row mkt-offer" + (o.mine ? " mine" : "") },
        el("i", { class: "dot" }),
        el("span", { class: "mk-main" },
          el("strong", {}, card.titre),
          el("small", { class: "muted" }, `${sells ? "Vend" : "Cherche"} · ${card.rarity.label} · ${o.mine ? "toi" : o.pseudo}`),
          sells && !o.mine ? el("small", { class: "muted" }, me.owned[o.card_id] ? `Tu en as ×${me.owned[o.card_id]}` : "Nouvelle pour toi") : null),
        el("span", { class: "mk-side" },
          el("b", { class: "mk-price" }, icon("coin", 12), money(o.price)),
          action));
      r.style.setProperty("--rc", card.rarity.color);
      return r;
    }).filter(Boolean);
  return el("div", {},
    el("p", { class: "muted small" }, "Mets une carte en vente ou propose d'en acheter une : un autre joueur peut accepter ton prix à tout moment."),
    newBtn,
    el("div", { class: "chips mkt-filters" }, chip("all", "Tout"), chip("sell", "Ventes"), chip("buy", "Achats"), mineChip),
    el("div", { class: "mk-list" }, rows.length ? rows : el("p", { class: "muted small empty-grid center" }, "Aucune offre pour ce filtre.")));
}

async function acceptOffer(o) {
  if (ui.busy || !me) return;
  const card = byId.get(o.card_id);
  ui.busy = "offer"; render();
  try {
    const seq = ++seqIssued;
    const j = await rpc("accept_player_offer", { p_offer_id: o.id });
    if (seq > seqApplied) { seqApplied = seq; applyProfile(j.profile); }
    if (j.stale) toast("Offre périmée : son auteur ne peut plus l'honorer. Tu n'as rien payé.");
    else {
      vibe(30);
      toast(j.side === "sell" ? `${card.titre} acheté · −${money(j.price)}` : `${card.titre} vendu · +${money(j.price)}`);
    }
  } catch (err) {
    toast(friendlyError(err));
    await refreshProfile({ force: true });
  }
  ui.busy = false;
  ui.market = null; ui.marketAt = 0;
  await loadOffers(true); render();
}

async function cancelOffer(o) {
  if (ui.busy) return;
  ui.busy = "offer"; render();
  try {
    await rpc("cancel_player_offer", { p_offer_id: o.id });
    toast("Offre annulée.");
  } catch (err) { toast(friendlyError(err)); }
  ui.busy = false;
  await loadOffers(true); render();
}

// Modale « Nouvelle offre »
function renderOfferModal(force) {
  const form = ui.offerForm;
  const typing = document.activeElement && $modal.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
  if (typing && !force) return;                                   // ne casse pas la saisie quand le profil se rafraîchit
  const sell = form.side === "sell";
  const cards = DECK_LIST_FOR_OFFERS();
  const options = cards
    .filter((c) => sell ? freeCopies(c.id) >= 1 : true)
    .sort((a, b) => a.rarity.tier - b.rarity.tier || a.titre.localeCompare(b.titre, "fr"));
  if (form.card && !options.some((c) => c.id === form.card)) form.card = "";
  const select = el("select", { class: "mkt-select", "aria-label": "Carte" },
    el("option", { value: "" }, sell ? "Choisis une carte à vendre" : "Choisis la carte voulue"),
    options.map((c) => el("option", { value: c.id, selected: c.id === form.card ? "" : null },
      `${c.titre} · ${c.rarity.label}${sell ? ` (×${freeCopies(c.id)})` : ""}`)));
  select.value = form.card;
  const ref = el("p", { class: "muted small mkt-ref" });
  const price = el("input", {
    class: "mkt-price-in", type: "number", inputmode: "numeric", min: "1", step: "1", placeholder: "Prix en Abri$", value: form.price,
    "aria-label": "Prix en Abri$", autocomplete: "off",
  });
  const mine = myOpenOffers().length, max = ui.mkt.maxOpen || 5;
  const submit = el("button", { class: "primary", type: "button" }, "Publier l'offre");
  const refresh = () => {
    const x = form.card ? marketEntry(form.card) : null;
    ref.textContent = x ? `Prix de la boutique pour cette carte : ${money(x.price)}` : "";
    const p = Math.floor(Number(form.price));
    const bad = !form.card || !(p > 0) || p > 10000000;
    const needAbris = !sell && p > 0 && me.abris < p;
    submit.disabled = bad || needAbris || mine >= max || !!ui.busy;
    submit.textContent = mine >= max ? `Limite de ${max} offres atteinte`
      : needAbris ? `Il te manque ${money(p - me.abris)}` : sell ? "Mettre en vente" : "Publier ma demande d'achat";
  };
  select.addEventListener("change", () => { form.card = select.value; refresh(); });
  price.addEventListener("input", () => { form.price = price.value; refresh(); });
  submit.addEventListener("click", () => publishOffer());
  const seg = (side, label) => el("button", {
    class: form.side === side ? "active" : "", type: "button",
    onclick: () => { form.side = side; form.card = ""; renderModal(true); },
  }, label);
  refresh();
  const box = el("div", { class: "modal-box", role: "dialog", "aria-label": "Nouvelle offre" },
    el("button", { class: "modal-x", type: "button", "aria-label": "Fermer", onclick: closeModal }, icon("close", 20)),
    el("h3", { class: "center" }, "Nouvelle offre"),
    el("div", { class: "seg" }, seg("sell", "Vendre une carte"), seg("buy", "Acheter une carte")),
    el("label", { class: "mkt-field" }, el("span", { class: "muted small" }, "Carte"), select),
    el("label", { class: "mkt-field" }, el("span", { class: "muted small" }, "Prix"), price),
    ref,
    el("p", { class: "muted small" }, sell
      ? "La carte reste dans ta collection jusqu'à ce qu'un joueur accepte. Tu reçois les Abri$ à ce moment-là."
      : "Les Abri$ ne sont débités que lorsqu'un joueur accepte ta demande. Garde-les en réserve : sinon l'offre sera annulée."),
    submit,
    el("button", { class: "secondary", type: "button", onclick: closeModal }, "Fermer"));
  $modal.replaceChildren(el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } }, box));
}
const DECK_LIST_FOR_OFFERS = () => [...byId.values()];

async function publishOffer() {
  const f = ui.offerForm;
  if (!f || ui.busy || !me) return;
  const p = Math.floor(Number(f.price));
  if (!f.card || !(p > 0)) return;
  ui.busy = "offer"; renderModal(true);
  let done = false;
  try {
    await rpc("create_player_offer", { p_side: f.side, p_card_id: f.card, p_price: p });
    const card = byId.get(f.card);
    toast(f.side === "sell" ? `${card.titre} mis en vente · ${money(p)}` : `Demande publiée : ${card.titre} · ${money(p)}`);
    done = true;
  } catch (err) { toast(friendlyError(err)); }
  ui.busy = false;
  if (done) { ui.offerForm = null; ui.modal = null; $modal.replaceChildren(); ui.mkt.mine = true; ui.mkt.filter = "all"; }
  await loadOffers(true);
  render(); if (ui.offerForm) renderModal(true);
}

/* ---------- Interface : paramètres ---------- */

function viewSettings() {
  const back = el("button", { class: "linklike left with-ico", type: "button", onclick: () => { ui.settings = false; ui.confirmReset = false; render(); } },
    icon("back", 16), "Retour");

  // Installation
  let installBody;
  if (isStandalone()) {
    installBody = el("p", { class: "set-ok" }, icon("check", 16), "Application déjà installée");
  } else if (deferredPrompt) {
    installBody = el("button", { class: "primary with-ico", type: "button", onclick: installApp },
      icon("download", 18), "Installer WikiBrand sur l'appareil");
  } else if (isIOS()) {
    installBody = el("div", {},
      el("p", { class: "set-steps" }, icon("share", 18), el("span", {}, "Touche ", el("strong", {}, "Partager"), " puis ", el("strong", {}, "Sur l'écran d'accueil"), ".")),
      el("p", { class: "muted small" }, "Depuis Safari uniquement. WikiBrand s'ouvrira ensuite comme une vraie application, en plein écran."));
  } else {
    installBody = el("p", { class: "muted small" },
      "Ton navigateur ne propose pas l'installation automatique pour l'instant. Ouvre son menu (⋮ ou Partager) et choisis « Installer l'application » ou « Ajouter à l'écran d'accueil ».");
  }

  const toggle = (key, label, hint) => el("label", { class: "set-row" },
    el("span", { class: "set-text" }, el("strong", {}, label), el("small", { class: "muted" }, hint)),
    el("input", {
      type: "checkbox", class: "switch", checked: !!prefs[key],
      onchange: (e) => { prefs[key] = e.target.checked; savePrefs(); applyPrefs(); if (key === "vibrate") vibe(25); },
    }));

  const reset = ui.confirmReset
    ? el("div", { class: "reset-row" },
        el("p", { class: "warning" }, icon("alert", 15), "Toutes tes cartes seront effacées. Tes Abri$ ne changent pas."),
        el("button", { class: "secondary danger", type: "button", onclick: async () => { await resetCollection(); } }, "Oui, effacer mes cartes"),
        el("button", { class: "secondary", type: "button", onclick: () => { ui.confirmReset = false; render(); } }, "Annuler"))
    : el("button", { class: "secondary danger-outline", type: "button", onclick: () => { ui.confirmReset = true; render(); } },
        icon("reset", 16), "Remettre ma collection à zéro");

  return el("section", { class: "view settings" },
    back,
    el("h2", { class: "section-title" }, "Paramètres"),

    el("div", { class: "set-card" },
      el("h3", {}, "Installer l'application"),
      installBody),

    el("div", { class: "set-card" },
      el("h3", {}, "Préférences"),
      toggle("vibrate", "Vibrations", "Retour tactile à l'ouverture des boosters"),
      toggle("calm", "Réduire les animations", "Moins d'effets : plus fluide sur un téléphone ancien")),

    el("div", { class: "set-card" },
      el("h3", {}, "Compte"),
      el("p", { class: "muted small" }, "Connecté en tant que ", el("strong", {}, me.pseudo)),
      el("button", { class: "secondary", type: "button", onclick: logout }, "Se déconnecter")),

    el("div", { class: "set-card danger-zone" },
      el("h3", {}, "Zone de danger"),
      reset),

    isAdmin() ? adminPanel() : null,
    el("p", { class: "muted small center set-version" }, `WikiBrand · version ${APP_VERSION}`)
  );
}

const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || prefs.calm;

function viewOpening() {
  if (ui.openStage === "tear") return viewOpenStage();
  if (ui.openStage === "recap" || ui.openIdx >= ui.opening.length) return viewRecap();
  return viewOpenStage();
}

// Calque fixe plein écran : les cartes éjectées s'y envolent sans jamais créer de défilement
function flyLayer() {
  let l = document.getElementById("fly-layer");
  if (!l) { l = el("div", { id: "fly-layer", "aria-hidden": "true" }); document.body.append(l); }
  return l;
}

/* Ouverture en une seule scène :
   1. le paquet se déchire progressivement de gauche à droite (la languette se soulève, une fente sombre s'ouvre) ;
   2. le sachet ouvert descend et reste visible en bas ;
   3. les cartes en sortent une par une, face cachée ; toucher = retourner ;
   4. une carte retournée se lance dans n'importe quelle direction (glisser > 75 px, ou simple tap) et la suivante sort du sachet. */
function viewOpenStage() {
  const items = ui.opening;
  const n = items.length;
  const THRESH = 75;
  let torn = ui.openStage === "reveal";
  let tearDone = torn;

  const pack = makePack({ big: true, tear: true, tier: ui.openTier });
  const btn = el("button", { class: "tear-btn", type: "button", "aria-label": "Ouvrir le booster (glisse sur le haut du paquet de gauche à droite, ou touche-le)" }, pack);
  const slit = el("div", { class: "os-slit" });
  const pouch = el("div", { class: "os-pouch" }, slit, btn);
  pouch.style.setProperty("--tear", torn ? "1" : "0");
  const stage = el("div", { class: "os" }, pouch);
  const flash = el("div", { class: "tear-flash" });

  const counter = el("span", { class: "deck-count" });
  const head = el("div", { class: "stack-head" }, el("span", { class: "muted small" }, "Carte"), counter);
  const title = el("div", { class: "open-title" },
    el("p", { class: "open-hint" }, "Déchire le paquet : glisse ton doigt sur le haut, de gauche à droite"),
    el("p", { class: "muted small center" }, "ou touche-le simplement"));
  const hint = el("p", { class: "muted center small deck-hint" });
  const allBtn = el("button", { class: "linklike reveal-all", type: "button" }, "Tout révéler");
  allBtn.addEventListener("click", () => { items.forEach((i) => { i.revealed = true; }); ui.openStage = "recap"; render(); });

  const setMode = () => {
    head.style.visibility = torn ? "visible" : "hidden";
    allBtn.style.visibility = torn ? "visible" : "hidden";
    title.classList.toggle("gone", torn);
    if (!torn) hint.textContent = "";
  };

  /* ----- cartes qui sortent du sachet ----- */
  const emerge = (idx, instant) => {
    const item = items[idx];
    const tier = item.card.rarity.tier;
    counter.textContent = `${idx + 1}/${n}`;
    hint.textContent = item.revealed ? "Glisse la carte dans n'importe quel sens, ou touche-la" : "Touche la carte pour la retourner";

    const card = el("button", {
      class: "dk-card os-card" + (instant ? "" : " in-pouch") + (item.revealed ? " revealed" : ""),
      type: "button", "data-tier": String(tier),
      "aria-label": item.revealed ? "Carte suivante" : "Retourner la carte",
    },
      el("div", { class: "dk-shake" },
        el("div", { class: "flip-inner" },
          el("div", { class: "face front" }, icon("card", 44)),
          el("div", { class: "face back" },
            cardFace(item.card, { stats: true }),
            item.isNew ? el("span", { class: "new" }, "NEW") : null))));
    card.style.setProperty("--rc", item.card.rarity.color);
    pouch.insertBefore(card, btn);
    if (!instant) {
      void card.offsetWidth;
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("in-pouch")));
    }

    let drag = null, moved = false, gone = false, usedPointer = false;
    const t = { x: 0, y: 0 };
    const setT = (x, y) => {
      t.x = x; t.y = y;
      card.style.translate = x || y ? `${x}px ${y}px` : "";
      const rot = Math.max(-60, Math.min(60, x * 0.12));
      card.style.rotate = rot ? `${rot}deg` : "";
    };

    const reveal = () => {
      if (item.revealed) return;
      item.revealed = true;
      card.classList.add("revealed");
      card.setAttribute("aria-label", "Carte suivante");
      if (tier >= 3) {                       // Épique / Légendaire / Divin : halo + secousse
        card.classList.add("fx", `fx-${tier}`);
        vibe(tier >= 4 ? [30, 40, 60] : 30);
      }
      hint.textContent = "Glisse la carte dans n'importe quel sens, ou touche-la";
    };

    // la carte s'envole dans la direction exacte du geste (dx*3, dy*3, au minimum 650 px) puis la suivante sort du sachet
    const fling = (dx, dy) => {
      if (gone) return;
      gone = true;
      let d = Math.hypot(dx, dy);
      if (d < 8) {                           // simple tap : direction aléatoire vers le haut
        const a = (-90 + (Math.random() * 90 - 45)) * Math.PI / 180;
        dx = Math.cos(a) * 220; dy = Math.sin(a) * 220; d = 220;
      }
      const k = Math.max(3, 650 / d);
      const tx = dx * k, ty = dy * k;
      const rot = Math.max(-80, Math.min(80, dx * 0.12)) * 2;

      const r = card.getBoundingClientRect();
      const w = card.offsetWidth, h = card.offsetHeight;
      const cx = r.left + r.width / 2 - t.x, cy = r.top + r.height / 2 - t.y;
      card.classList.remove("dragging", "in-pouch");
      card.classList.add("flying");
      Object.assign(card.style, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px` });
      const layer = flyLayer();
      layer.append(card);
      if (reducedMotion()) card.remove();
      else {
        void card.offsetWidth;
        requestAnimationFrame(() => {
          card.style.translate = `${tx}px ${ty}px`;
          card.style.rotate = `${rot}deg`;
          card.style.opacity = "0";
        });
        setTimeout(() => card.remove(), 650);
      }
      vibe(12);
      ui.openIdx = idx + 1;
      if (idx + 1 >= n) setTimeout(() => { ui.openStage = "recap"; render(); }, reducedMotion() ? 0 : 420);
      else setTimeout(() => emerge(idx + 1, reducedMotion()), reducedMotion() ? 0 : 140);
    };

    card.addEventListener("dragstart", (e) => e.preventDefault());
    card.addEventListener("pointerdown", (e) => {
      if (gone) return;
      usedPointer = true;
      drag = { x0: e.clientX, y0: e.clientY };
      moved = false;
      if (card.setPointerCapture) { try { card.setPointerCapture(e.pointerId); } catch {} }
    });
    card.addEventListener("pointermove", (e) => {
      if (!drag || gone || !item.revealed) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (moved) { card.classList.add("dragging"); setT(dx, dy); }
    });
    const end = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      drag = null;
      card.classList.remove("dragging");
      if (!item.revealed) { reveal(); setT(0, 0); return; }
      if (moved && Math.hypot(dx, dy) > THRESH) fling(dx, dy);
      else if (!moved) fling(0, 0);          // simple tap
      else setT(0, 0);                       // pas assez tiré : la carte revient
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", () => { drag = null; card.classList.remove("dragging"); setT(0, 0); });
    card.addEventListener("click", () => {   // clavier / lecteur d'écran (les gestes tactiles passent par pointerup)
      if (usedPointer) { usedPointer = false; return; }
      if (!item.revealed) reveal(); else fling(0, 0);
    });
  };

  /* ----- déchirure ----- */
  const dock = (instant) => {
    pouch.classList.toggle("instant", !!instant);
    pouch.classList.add("docked");
  };
  const tearNow = () => {
    if (tearDone) return;
    tearDone = true; torn = true;
    pouch.style.setProperty("--tear", "1");
    pack.classList.add("torn");
    ui.openStage = "reveal"; ui.openIdx = 0;
    vibe(30);
    setMode();
    if (reducedMotion()) { dock(true); emerge(0, true); return; }
    stage.after(flash);
    setTimeout(() => dock(false), 380);
    setTimeout(() => emerge(0, false), 1050);
  };

  let drag = null, dragged = false, p = 0;
  btn.addEventListener("pointerdown", (e) => {
    if (tearDone) return;
    const r = pack.getBoundingClientRect();
    dragged = false;
    drag = e.clientY - r.top < r.height * 0.45 ? { left: r.left, w: r.width } : null;   // zone de découpe : le haut
    if (drag && btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch {} }
  });
  btn.addEventListener("pointermove", (e) => {
    if (!drag || tearDone) return;
    p = Math.max(0, Math.min(1, (e.clientX - drag.left) / drag.w));
    if (p > 0.05) dragged = true;
    pouch.style.setProperty("--tear", p.toFixed(3));
    if (p >= 0.97) tearNow();
  });
  const release = () => {
    if (!drag || tearDone) return;
    drag = null;
    if (!dragged) return;
    if (p > 0.6) tearNow();                  // presque déchiré : on termine
    else pouch.style.setProperty("--tear", "0");   // pas assez tiré : la languette se remet en place
  };
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("click", () => {
    if (dragged && !tearDone) { dragged = false; return; }
    tearNow();
  });

  setMode();
  if (torn) {                                // re-rendu en cours d'ouverture : on restaure l'état
    pack.classList.add("torn", "restored");
    dock(true);
    emerge(Math.min(ui.openIdx, n - 1), true);
  }

  return el("section", { class: "view stack-stage open-scene" }, head, title, stage, hint, allBtn);
}

// Fin : toutes les cartes du booster d'un coup
function viewRecap() {
  const items = ui.opening;
  return el("section", { class: "view" },
    el("h2", { class: "section-title center" }, "Contenu du booster"),
    el("div", { class: "tile-grid recap" }, items.map((it) =>
      el("button", { class: "tile", type: "button", onclick: () => showCard(it.card) },
        cardFace(it.card),
        it.isNew ? el("span", { class: "new" }, "NEW") : null))),
    el("button", { class: "primary", onclick: () => { ui.opening = null; render(); } }, "Continuer")
  );
}

/* ---------- Interface : collection ---------- */

function viewCollection() {
  const nFilters = (ui.cat ? 1 : 0) + (ui.sub ? 1 : 0) + (ui.rarity ? 1 : 0);
  const reset = () => { ui.cat = ui.sub = ui.rarity = null; render(); };

  const chip = (label, active, onclick, color = null) => {
    const b = el("button", { class: "chip" + (active ? " active" : "") + (color ? " rar-chip" : ""), type: "button", onclick },
      color ? el("i", { class: "dot" }) : null, label);
    if (color) b.style.setProperty("--rc", color);
    return b;
  };

  // Pilules de tri : toucher la pilule active inverse le sens
  const pill = (key, label) => {
    const active = ui.sort.key === key;
    const dir = active ? ui.sort.dir : SORTS[key].dir;
    const b = el("button", {
      class: "sort-pill" + (active ? ` active ${dir}` : ""), type: "button",
      "aria-pressed": active ? "true" : "false",
      "aria-label": `Trier par ${label}${active ? ` : ${SORTS[key].hint[dir]} (toucher pour inverser)` : ""}`,
      onclick: () => {
        ui.sort = active ? { key, dir: dir === "asc" ? "desc" : "asc" } : { key, dir: SORTS[key].dir };
        render();
      },
    }, label, active ? icon("arrowdown", 14) : null);
    return b;
  };

  const toolbar = el("div", { class: "coll-tools" },
    el("div", { class: "sort-pills" }, pill("rarity", "Rareté"), pill("name", "Nom"), pill("obtained", "Date")),
    el("div", { class: "tool-actions" },
      el("button", { class: "tool-btn" + (ui.filtersOpen ? " on" : ""), type: "button", "aria-expanded": ui.filtersOpen ? "true" : "false",
        onclick: () => { ui.filtersOpen = !ui.filtersOpen; render(); } },
        icon("filter", 16), "Filtres", nFilters ? el("span", { class: "tool-badge" }, String(nFilters)) : null),
      nFilters ? el("button", { class: "tool-btn ghost", type: "button", onclick: reset }, icon("reset", 15), "Réinitialiser") : null)
  );

  // Tiroir : catégories, sous-catégories, raretés
  const subs = ui.cat ? [...tree.get(ui.cat)] : [];
  const drawer = ui.filtersOpen
    ? el("div", { class: "filter-drawer" },
        el("h3", {}, "Catégorie"),
        el("div", { class: "chip-wrap" },
          chip(`Toutes ${fmtStats(collectionStats())}`, !ui.cat, () => { ui.cat = null; ui.sub = null; render(); }),
          [...tree.keys()].map((c) => chip(`${c} ${fmtStats(collectionStats(c))}`, ui.cat === c, () => { ui.cat = c; ui.sub = null; render(); }))),
        subs.length ? [
          el("h3", {}, "Sous-catégorie"),
          el("div", { class: "chip-wrap" },
            chip("Toutes", !ui.sub, () => { ui.sub = null; render(); }),
            subs.map((s) => chip(`${s} ${fmtStats(collectionStats(ui.cat, s))}`, ui.sub === s, () => { ui.sub = s; render(); }))),
        ] : null,
        el("h3", {}, "Rareté"),
        el("div", { class: "chip-wrap" },
          chip(`Toutes ${fmtStats(collectionStats(ui.cat, ui.sub))}`, !ui.rarity, () => { ui.rarity = null; render(); }),
          RARITIES.map((r) => chip(`${r.label} ${fmtStats(collectionStats(ui.cat, ui.sub, r.key))}`, ui.rarity === r.key,
            () => { ui.rarity = ui.rarity === r.key ? null : r.key; render(); }, r.color))))
    : null;

  const cards = sortCards(catalog.filter((c) =>
    (!ui.cat || c.categorie === ui.cat) && (!ui.sub || c.sous === ui.sub) && (!ui.rarity || c.rarity.key === ui.rarity)));

  const grid = el("div", { class: "tile-grid" },
    cards.length ? null : el("p", { class: "muted small empty-grid" }, "Aucune carte avec ces filtres."),
    cards.map((card) => {
      const count = me.owned[card.id] || 0;
      if (!count) {
        // Carte non possédée : silhouette sur verre dépoli + cadenas
        return el("button", { class: "tile card-locked", type: "button", "aria-label": `Carte pas encore découverte (${card.rarity.label}) : voir le prix`, onclick: () => showCard(card) },
          cardFace(card),
          el("span", { class: "lock-badge" }, icon("lock", 18)));
      }
      return el("button", { class: "tile", onclick: () => showCard(card) },
        cardFace(card),
        count > 1 ? el("span", { class: "count" }, `×${count}`) : null
      );
    })
  );

  const issues = catalogIssues.length
    ? el("p", { class: "warning" }, icon("alert", 16), ` ${catalogIssues.length} carte(s) de cards.json ignorée(s). Détails dans la console du navigateur.`)
    : null;

  const g = collectionStats();
  const pct = g.total ? Math.round((g.owned / g.total) * 100) : 0;
  const counter = el("h2", { class: "dex-counter" }, `Collection : ${g.owned}/${g.total} cartes (${pct}%)`);
  const dexBar = el("div", { class: "dex-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
    el("i", {}));
  dexBar.firstChild.style.setProperty("--w", `${pct}%`);

  return el("section", { class: "view" }, counter, dexBar, issues, toolbar, drawer, grid);
}

/* ---------- Interface : profil ---------- */

function viewProfile() {
  const s = collectionStats();
  const copies = Object.values(me.owned).reduce((x, y) => x + y, 0);
  const pct = s.total ? Math.round((s.owned / s.total) * 100) : 0;

  const stat = (v, l) => el("div", { class: "pp-stat" }, el("b", {}, String(v)), el("span", {}, l));
  const bar = el("div", { class: "dex-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, el("i", {}));
  bar.firstChild.style.setProperty("--w", `${pct}%`);

  const passport = el("div", { class: "passport" },
    el("div", { class: "pp-top" },
      avatar(me.pseudo, true),
      el("div", { class: "pp-id" },
        el("span", { class: "pp-tag" }, "Passeport WikiBrand"),
        el("h2", { class: "pp-name" }, me.pseudo),
        el("span", { class: "pp-gold" }, icon("coin", 16), money(me.abris)))),
    el("div", { class: "pp-stats" },
      stat(`${pct}%`, "Complétion"), stat(`${s.owned}/${s.total}`, "Cartes uniques"), stat(fmtNum(copies), "Cartes au total")),
    bar);

  const rows = RARITIES.map((r) => {
    const all = byRarity.get(r.key) || [];
    const have = all.filter((c) => (me.owned[c.id] || 0) > 0).length;
    const w = all.length ? Math.round((have / all.length) * 100) : 0;
    const fill = el("i", {});
    fill.style.width = `${w}%`;
    const row = el("div", { class: "rbar" },
      el("div", { class: "rbar-head" }, el("i", { class: "dot" }), el("strong", {}, r.label), el("span", { class: "odd-pct" }, `${have} / ${all.length}`)),
      el("div", { class: "rbar-track" }, fill));
    row.style.setProperty("--rc", r.color);
    return row;
  });

  return el("section", { class: "view" },
    passport,
    el("h2", { class: "section-title" }, "Progression par rareté"),
    el("div", { class: "rbars" }, rows),
    achievementsEntry()
  );
}

/* ---------- Succès : bouton du Profil + page dédiée à paliers ---------- */

// Regroupe les paliers par famille. Ancien serveur (sans "grp") : chaque succès devient une famille à 1 palier.
function achGroups() {
  const by = new Map();
  (achievements || []).forEach((x) => {
    const g = x.grp || x.id;
    if (!by.has(g)) by.set(g, []);
    by.get(g).push({ ...x, tier: x.tier || 1 });
  });
  const order = Object.keys(ACH_GROUPS);
  return [...by.entries()]
    .map(([grp, tiers]) => ({ grp, tiers: tiers.sort((p, q) => p.tier - q.tier) }))
    .sort((p, q) => (order.indexOf(p.grp) + 1 || 99) - (order.indexOf(q.grp) + 1 || 99));
}

function achSummary() {
  const all = achievements || [];
  const ready = all.filter((x) => !x.claimed && x.progress >= x.target).length;
  return { total: all.length, claimed: all.filter((x) => x.claimed).length, ready };
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

function achievementsEntry() {
  const sm = achSummary();
  const pct = sm.total ? Math.round((sm.claimed / sm.total) * 100) : 0;
  const bar = el("div", { class: "ach-bar" }, el("i", {}));
  bar.firstChild.style.width = `${pct}%`;
  return el("button", {
    class: "ach-entry" + (sm.ready ? " has-ready" : ""), type: "button",
    onclick: () => { ui.achPage = true; render(); loadAchievements(); },
  },
    el("span", { class: "ach-entry-ico" }, icon("trophy", 24)),
    el("span", { class: "ach-entry-body" },
      el("strong", {}, "Succès"),
      el("small", { class: "muted" }, achievements
        ? `${sm.claimed} / ${sm.total} paliers réclamés${sm.ready ? ` · ${sm.ready} à réclamer` : ""}`
        : "Chargement…"),
      achievements ? bar : null),
    sm.ready ? el("span", { class: "ach-entry-badge" }, String(sm.ready)) : null,
    icon("chevron", 18));
}

function viewAchievements() {
  const back = el("button", { class: "linklike left with-ico", type: "button", onclick: () => { ui.achPage = false; render(); } },
    icon("back", 16), "Retour au profil");
  if (!achievements) return el("section", { class: "view" }, back, el("p", { class: "muted center" }, "Chargement des succès…"));

  const sm = achSummary();
  const pct = sm.total ? Math.round((sm.claimed / sm.total) * 100) : 0;
  const bar = el("div", { class: "ach-bar big" }, el("i", {}));
  bar.firstChild.style.width = `${pct}%`;

  const cards = achGroups().map(({ grp, tiers }) => {
    const g = ACH_GROUPS[grp] || ACH_UI[grp] || { icon: "star", title: grp };
    const cur = tiers.find((t) => !t.claimed);                // palier en cours
    const allDone = !cur;
    const shown = cur || tiers[tiers.length - 1];
    const unlocked = shown.progress >= shown.target;
    const state = allDone ? "done" : unlocked ? "ready" : "locked";
    const pctT = Math.min(100, Math.round((shown.progress / shown.target) * 100));
    const barT = el("div", { class: "ach-bar" }, el("i", {}));
    barT.firstChild.style.width = `${pctT}%`;
    const desc = typeof g.desc === "function" ? g.desc(shown.target) : g.desc || "";
    const chips = tiers.length > 1 ? el("div", { class: "tier-chips", role: "list" }, tiers.map((t) => {
      const st = t.claimed ? "claimed" : t === cur ? (t.progress >= t.target ? "ready" : "current") : "locked";
      return el("span", { class: `tier-chip ${st}`, role: "listitem", title: `Palier ${ROMAN[t.tier] || t.tier}` },
        t.claimed ? icon("check", 12) : ROMAN[t.tier] || String(t.tier));
    })) : null;

    return el("article", { class: `ach-grp ${state}` },
      el("div", { class: "ach-grp-head" },
        el("span", { class: "ach-ico" }, icon(state === "locked" ? "lock" : g.icon, 22)),
        el("div", { class: "ach-grp-title" },
          el("strong", {}, g.title),
          el("small", { class: "muted" }, allDone ? "Tous les paliers réclamés"
            : tiers.length > 1 ? `Palier ${ROMAN[shown.tier] || shown.tier} sur ${ROMAN[tiers.length] || tiers.length}` : "Succès unique")),
        chips),
      el("p", { class: "ach-desc" }, desc),
      barT,
      el("div", { class: "ach-foot" },
        el("small", { class: "ach-prog" }, `${fmtNum(shown.progress)} / ${fmtNum(shown.target)}`),
        allDone ? el("span", { class: "ach-done" }, icon("check", 15), "Terminé")
          : unlocked
            ? el("button", { class: "ach-claim", disabled: ui.busy ? "" : null, onclick: () => claimAchievement(shown.id) },
                icon("coin", 15), `Réclamer +${fmtNum(shown.reward)}`)
            : el("span", { class: "ach-reward" }, icon("lock", 13), `+${fmtNum(shown.reward)} ${CURRENCY}`)));
  });

  return el("section", { class: "view ach-page" },
    back,
    el("h2", { class: "section-title" }, "Succès"),
    el("div", { class: "ach-summary" },
      el("div", { class: "ach-sum-top" },
        el("strong", {}, `${sm.claimed} / ${sm.total}`), el("span", { class: "muted small" }, "paliers réclamés"),
        sm.ready ? el("span", { class: "ach-ready-pill" }, `${sm.ready} à réclamer`) : null),
      bar),
    el("div", { class: "ach-groups" }, cards));
}

async function adminRefill() {
  if (ui.busy) return;
  ui.busy = true;
  try {
    await profileCall("admin_refill");
    toast("Stock rechargé : 5 boosters, +1000 Abri$");
  } catch (err) {
    toast(friendlyError(err));
  }
  ui.busy = false;
  render();
}

function adminPanel() {
  const a = ui.admin;
  const set = (patch) => { Object.assign(a, patch); render(); };
  const rarSelect = el("select", { onchange: (e) => { a.rarity = e.target.value; } },
    RARITIES.map((r) => el("option", { value: r.key, selected: r.key === a.rarity }, `${r.tier} · ${r.label}`)));
  const luck = el("input", { type: "number", min: "1", max: "1000", step: "1", value: String(a.luck),
    onchange: (e) => { a.luck = Math.min(1000, Math.max(1, Number(e.target.value) || 1)); e.target.value = a.luck; } });

  return el("details", {
    class: "admin-panel",
    open: a.open || a.test,
    ontoggle: (e) => { a.open = e.currentTarget.open; },
  },
    el("summary", {}, icon("flask", 16), " Mode testeur"),
    el("button", { class: "secondary", disabled: ui.busy ? "" : null, onclick: adminRefill }, "Recharger boosters + 1000 Abri$"),
    el("label", { class: "admin-row" },
      el("input", { type: "checkbox", checked: a.test, onchange: (e) => set({ test: e.target.checked }) }),
      " Boosters de test (infinis) sur l'onglet Boosters"),
    a.test ? el("div", { class: "admin-opts" },
      el("label", {}, el("input", { type: "radio", name: "admode", checked: a.mode === "luck", onchange: () => set({ mode: "luck" }) }), " Luck ×", luck),
      el("label", {}, el("input", { type: "radio", name: "admode", checked: a.mode === "force", onchange: () => set({ mode: "force" }) }), " Rareté forcée ", rarSelect)
    ) : null
  );
}

/* ---------- Communauté : données ---------- */

const emptySocial = () => ({ friends: [], incoming: [], outgoing: [], tradesIn: [], tradesOut: [], history: [] });
let social = emptySocial();

/* ---------- Succès & classement (calculés et validés par le serveur) ---------- */

// Seuls l'icône et les textes sont ici ; objectifs et récompenses viennent de list_achievements().
const ACH_UI = {
  unique_3:        { icon: "card", title: "Premiers pas",       desc: "Possède 3 cartes différentes" },
  unique_5:        { icon: "collection", title: "Collectionneur",     desc: "Possède 5 cartes différentes" },
  complete_all:    { icon: "trophy", title: "Collection complète", desc: "Possède toutes les cartes du jeu" },
  have_legendaire: { icon: "star", title: "Légende vivante",    desc: "Obtiens une carte Légendaire" },
  have_divin:      { icon: "crown", title: "Hors-barème",        desc: "Obtiens une carte Divin" },
  rich_1000:       { icon: "coin", title: "Petit trésor",       desc: "Atteins 1 000 Abri$ en réserve" },
  friend_1:        { icon: "userplus", title: "Premier ami",        desc: "Ajoute un ami" },
  friend_3:        { icon: "friends", title: "Bande de potes",     desc: "Aie 3 amis" },
};
const pl = (n, w) => `${fmtNum(n)} ${w}${n > 1 ? "s" : ""}`;
// Familles de succès (textes et icônes). Objectifs, récompenses et progression viennent de list_achievements().
const ACH_GROUPS = {
  collection: { icon: "collection", title: "Collectionneur",     desc: (t) => `Possède ${pl(t, "carte")} différente${t > 1 ? "s" : ""}` },
  copies:     { icon: "card",       title: "Grand stock",        desc: (t) => `Cumule ${pl(t, "carte")} en tout (doubles compris)` },
  epic:       { icon: "sparkle",    title: "Chasseur d'épiques", desc: (t) => `Possède ${pl(t, "carte")} Épique différente${t > 1 ? "s" : ""}` },
  legend:     { icon: "star",       title: "Légende vivante",    desc: (t) => `Possède ${pl(t, "carte")} Légendaire différente${t > 1 ? "s" : ""}` },
  divin:      { icon: "crown",      title: "Hors-barème",        desc: (t) => `Possède ${pl(t, "carte")} Divin différente${t > 1 ? "s" : ""}` },
  rich:       { icon: "coin",       title: "Fortune",            desc: (t) => `Atteins ${fmtNum(t)} ${CURRENCY} en réserve` },
  friends:    { icon: "friends",    title: "Sociable",           desc: (t) => `Aie ${pl(t, "ami")}` },
  trades:     { icon: "swap",       title: "Négociant",          desc: (t) => `Réussis ${pl(t, "échange")}` },
  shop:       { icon: "shop",       title: "Acheteur",           desc: (t) => `Achète ${pl(t, "booster")} en boutique` },
};
let achievements = null;   // [{id, grp, tier, target, reward, progress, claimed}]
let board = null;          // {top, me, total_cards, players}

async function loadAchievements() {
  if (!me) return;
  try {
    achievements = await rpc("list_achievements");
    if ((ui.tab === "profile" || ui.achPage) && !ui.settings && !ui.opening) render();
  } catch (err) { console.warn("[achievements]", err); }
}

async function claimAchievement(id) {
  if (ui.busy) return;
  const a = (achievements || []).find((x) => x.id === id);
  ui.busy = true;
  render();
  try {
    await profileCall("claim_achievement", { p_id: id });
    vibe(30);
    toast(`Succès réclamé : +${money(a ? a.reward : 0)}`);
  } catch (err) {
    toast(friendlyError(err));
  }
  ui.busy = false;
  await loadAchievements();
  render();
}

async function loadBoard() {
  if (!me) return;
  try {
    board = await rpc("get_leaderboard");
  } catch (err) {
    console.warn("[leaderboard]", err);
    board = { error: true };
  }
  if (ui.tab === "friends" && ui.friendsTab === "ranking" && !ui.visit) render();
}
const socialBadge = () => social.incoming.length + social.tradesIn.length;

// Recharge amis, demandes et échanges. Redessine l'onglet Amis s'il est ouvert
// (sauf pendant que le joueur tape dans la recherche), sinon met juste à jour le badge.
async function refreshSocial() {
  if (!me) return;
  try {
    const j = await rpc("list_social");
    social = { friends: j.friends, incoming: j.incoming, outgoing: j.outgoing, tradesIn: j.trades_in, tradesOut: j.trades_out, history: j.history };
    const typing = document.activeElement && document.activeElement.id === "friend-search";
    if (ui.tab === "friends" && !ui.opening && !typing) render();
    else { const n = document.querySelector(".nav"); if (n) n.replaceWith(nav()); }
  } catch (err) {
    console.warn("[social]", err);
  }
}

// Exécute une action sociale (une seule à la fois), affiche le résultat, puis recharge.
async function socialAction(fn, okMessage) {
  if (ui.busy) return false;
  ui.busy = true;
  let ok = false;
  try {
    const res = await fn();
    ok = true;
    const msg = typeof okMessage === "function" ? okMessage(res) : okMessage;
    if (msg) toast(msg);
  } catch (err) {
    toast(friendlyError(err));
  }
  ui.busy = false;
  await refreshSocial();
  return ok;
}

// Les résultats de recherche affichent le lien avec chaque joueur : on les met à jour après une action
async function refreshSearchData() {
  if (ui.search.q.length < 2) return;
  try { ui.search.results = await rpc("search_players", { p_query: ui.search.q }); } catch { /* sans gravité */ }
}

const sendRequest = (pseudo) => socialAction(
  async () => { const r = await rpc("send_friend_request", { p_pseudo: pseudo }); await refreshSearchData(); return r; },
  (r) => (r.result === "accepted" ? `Vous êtes maintenant amis avec ${pseudo} !` : `Demande envoyée à ${pseudo}.`)
);

const respondRequest = (pseudo, accept) => socialAction(
  async () => { await rpc("respond_friend_request", { p_pseudo: pseudo, p_accept: accept }); await refreshSearchData(); },
  accept ? `${pseudo} est maintenant ton ami.` : "Demande refusée."
);

const acceptTrade = (id) => socialAction(() => profileCall("accept_trade", { p_trade_id: id }), "Échange réussi !");
const declineTrade = (id) => socialAction(() => rpc("decline_trade", { p_trade_id: id }), "Proposition refusée.");
const cancelTrade = (id) => socialAction(() => rpc("cancel_trade", { p_trade_id: id }), "Proposition annulée.");

async function runSearch(q, box) {
  q = q.trim();
  ui.search.q = q;
  if (q.length < 2) {
    ui.search.results = null;
    return renderSearchResults(box, "Tape au moins 2 caractères.");
  }
  try {
    ui.search.results = await rpc("search_players", { p_query: q });
  } catch (err) {
    return toast(friendlyError(err));
  }
  renderSearchResults(box);
}

async function openVisit(pseudo) {
  ui.tab = "friends";
  ui.visit = { pseudo, data: null };
  render();
  window.scrollTo(0, 0);
  try {
    const data = await rpc("get_friend_profile", { p_pseudo: pseudo });
    if (ui.visit && ui.visit.pseudo === pseudo) ui.visit.data = data;
  } catch (err) {
    toast(friendlyError(err));
    ui.visit = null;
  }
  render();
}

/* ---------- Communauté : interface ---------- */

const smallBtn = (label, onclick, cls = "") => el("button", { class: "btn-sm with-ico " + cls, type: "button", onclick }, label);

function personRow(pseudo, ...actions) {
  return el("div", { class: "row-item" },
    avatar(pseudo),
    el("span", { class: "who" }, pseudo),
    el("div", { class: "row-actions" }, actions));
}

// Cartes du catalogue présentes dans une collection, les plus rares d'abord
function ownedCards(owned) {
  return catalog
    .filter((c) => (owned[c.id] || 0) > 0)
    .sort((a, b) => b.rarity.tier - a.rarity.tier || a.titre.localeCompare(b.titre, "fr"));
}

const cardName = (id) => (byId.get(id) || { titre: id }).titre;

function viewFriends() {
  if (ui.visit) return viewVisit();

  const seg = (id, label, count) =>
    el("button", {
      class: ui.friendsTab === id ? "active" : "", type: "button",
      onclick: () => { ui.friendsTab = id; render(); if (id === "ranking") loadBoard(); },
    }, label, count > 0 ? el("span", { class: "seg-count" }, String(count)) : null);

  return el("section", { class: "view" },
    el("div", { class: "seg" },
      seg("friends", "Amis", social.incoming.length),
      seg("trades", "Échanges", social.tradesIn.length),
      seg("ranking", "Classement", 0)),
    ui.friendsTab === "trades" ? viewTrades() : ui.friendsTab === "ranking" ? viewRanking() : viewFriendList()
  );
}

function viewRanking() {
  if (!board) return el("p", { class: "muted center loading" }, "Chargement du classement…");
  if (board.error) return el("p", { class: "warning" }, icon("alert", 16), " Classement indisponible (exécute achievements.sql dans Supabase).");

  const mine = (p) => p.pseudo.toLowerCase() === me.pseudo.toLowerCase();
  const detail = (p) => el("small", {}, `${p.unique_owned}/${board.total_cards} cartes · `, icon("star", 12), ` ${p.top_cards}`);

  const step = (p) => el("div", { class: `pod rank-${p.rank}${mine(p) ? " me" : ""}` },
    p.rank === 1 ? el("span", { class: "pod-crown" }, icon("crown", 28)) : null,
    avatar(p.pseudo, true),
    el("div", { class: "pod-name" }, p.pseudo),
    el("div", { class: "pod-sub" }, `${p.unique_owned}/${board.total_cards}`),
    el("div", { class: "pod-sub gold" }, money(p.value)),
    el("div", { class: "pod-block" }, el("b", {}, String(p.rank))));
  const top3 = board.top.slice(0, 3).map(step);
  const ordered = [top3[1], top3[0], top3[2]].filter(Boolean);     // 2e, 1er, 3e

  const row = (p) => el("div", { class: "rank-row" + (mine(p) ? " me" : "") },
    el("span", { class: "rank-n" }, String(p.rank)),
    avatar(p.pseudo),
    el("span", { class: "rank-who" }, el("strong", {}, p.pseudo, mine(p) ? el("em", { class: "you" }, "TOI") : null), detail(p)),
    el("span", { class: "rank-val" }, money(p.value)));

  const inTop = board.me && board.top.some(mine);
  return el("div", {},
    el("p", { class: "muted small" }, `${board.players} joueur${board.players > 1 ? "s" : ""} · classés par cartes uniques, puis valeur de revente de la collection.`),
    ordered.length ? el("div", { class: "podium" }, ordered) : emptyState("trophy", "Personne dans le classement", "Ouvre un booster pour y entrer."),
    el("div", { class: "rank-list" }, board.top.slice(3).map(row)),
    board.me && !inTop ? [el("p", { class: "muted center small" }, "···"), el("div", { class: "rank-list" }, row(board.me))] : null
  );
}

function relationActions(r) {
  switch (r.relation) {
    case "friend": return [smallBtn("Voir le profil", () => openVisit(r.pseudo), "ghost")];
    case "sent": return [el("span", { class: "muted small" }, "Demande envoyée")];
    case "received": return [smallBtn("Accepter", () => respondRequest(r.pseudo, true))];
    default: return [smallBtn([icon("userplus", 15), "Ajouter"], () => sendRequest(r.pseudo))];
  }
}

function renderSearchResults(box, hint) {
  const res = ui.search.results;
  if (!res) return box.replaceChildren(...(hint ? [el("p", { class: "muted small" }, hint)] : []));
  if (!res.length) return box.replaceChildren(emptyState("search", "Aucun joueur trouvé", "Vérifie l'orthographe du pseudo."));
  box.replaceChildren(el("div", { class: "rows" }, res.map((r) => personRow(r.pseudo, ...relationActions(r)))));
}

function viewFriendList() {
  const box = el("div", { class: "results" });
  const input = el("input", {
    id: "friend-search", type: "search", maxlength: "16", autocomplete: "off", autocapitalize: "off",
    spellcheck: "false", placeholder: "Rechercher un joueur par pseudo", "aria-label": "Rechercher un joueur par pseudo",
    value: ui.search.q,
  });
  const form = el("form", { class: "search", novalidate: "" }, input, el("button", { type: "submit" }, "Chercher"));
  form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(input.value, box); });
  renderSearchResults(box);

  return el("div", {},
    form,
    box,
    social.incoming.length
      ? [el("h2", { class: "section-title" }, `Demandes reçues (${social.incoming.length})`),
         el("div", { class: "rows" }, social.incoming.map((r) =>
           personRow(r.pseudo,
             smallBtn("Accepter", () => respondRequest(r.pseudo, true)),
             smallBtn("Refuser", () => respondRequest(r.pseudo, false), "ghost"))))]
      : null,
    social.outgoing.length
      ? [el("h2", { class: "section-title" }, "Demandes envoyées"),
         el("div", { class: "rows" }, social.outgoing.map((r) =>
           personRow(r.pseudo, el("span", { class: "muted small" }, "En attente"))))]
      : null,
    el("h2", { class: "section-title" }, `Mes amis (${social.friends.length})`),
    social.friends.length
      ? el("div", { class: "rows" }, social.friends.map((f) =>
          el("button", { class: "row-item friend", type: "button", onclick: () => openVisit(f.pseudo) },
            avatar(f.pseudo),
            el("span", { class: "who" }, f.pseudo),
            el("span", { class: "muted small go" }, "Voir le profil", icon("chevron", 16)))))
      : emptyState("friends", "Pas encore d'amis", "Cherche un pseudo ci-dessus pour envoyer une demande.")
  );
}

/* --- Profil d'un ami (lecture seule) --- */

function viewVisit() {
  const v = ui.visit;
  const back = el("button", { class: "linklike left with-ico", type: "button", onclick: () => { ui.visit = null; render(); } }, icon("back", 16), "Retour aux amis");
  if (!v.data) return el("section", { class: "view" }, back, el("p", { class: "muted center" }, "Chargement du profil…"));

  const d = v.data;
  const pct = d.total_cards ? Math.min(100, Math.round((100 * d.unique_owned) / d.total_cards)) : 0;
  const cards = ownedCards(d.owned);

  const progress = el("div", { class: "progress", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" },
    el("span", {}));
  progress.firstChild.style.width = pct + "%";

  return el("section", { class: "view" },
    back,
    el("div", { class: "profile-head" }, avatar(d.pseudo, true), el("h2", { class: "section-title big" }, d.pseudo)),
    el("dl", { class: "visit-stats" },
      el("div", { class: "stat" }, el("dt", {}, "Solde"), el("dd", { class: "gold" }, money(d.abris))),
      el("div", { class: "stat" }, el("dt", {}, "Collection"), el("dd", {}, `${pct} %`))),
    progress,
    el("p", { class: "muted small" }, `${d.unique_owned} carte(s) différente(s) sur ${d.total_cards}`),
    el("button", { class: "primary with-ico", onclick: () => showTradeModal(d.pseudo) }, icon("swap", 18), "Proposer un échange"),
    el("h2", { class: "section-title" }, `Ses cartes (${cards.length})`),
    cards.length
      ? [el("p", { class: "muted small" }, "Touche une carte pour la demander en échange."),
         el("div", { class: "tile-grid" }, cards.map((card) => {
           const count = d.owned[card.id];
           return el("button", { class: "tile", type: "button", onclick: () => showTradeModal(d.pseudo, card.id) },
             cardFace(card),
             count > 1 ? el("span", { class: "count" }, `×${count}`) : null);
         }))]
      : el("p", { class: "muted small" }, "Cet ami n'a encore aucune carte.")
  );
}

/* --- Lots de cartes (affichage compact) --- */

const MAX_TRADE_CARDS = 5;

// Regroupe les doublons en gardant l'ordre : [a, a, b] -> [[a,2],[b,1]]
function groupCards(list) {
  const m = new Map();
  list.forEach((c) => m.set(c.id, { card: c, n: (m.get(c.id) || { n: 0 }).n + 1 }));
  return [...m.values()].map((x) => [x.card, x.n]);
}

function miniCard(card, n) {
  const node = el("div", { class: "mini-card", "data-tier": String(card.rarity.tier), title: card.titre },
    cardArt(card), n > 1 ? el("span", { class: "mini-n" }, `×${n}`) : null);
  node.style.setProperty("--rc", card.rarity.color);
  return node;
}

// Un camp d'un échange : mini-grille de cartes + badge doré "+X Abri$" si de l'argent est de ce côté
// cards : [{id, rarete}] (ou [{id, card}])
function lotView(cards, abris, label) {
  const groups = groupCards(cards.map((c) => cardFromServer(c.id, c.rarete)));
  const cols = Math.min(3, Math.max(1, groups.length));
  const grid = el("div", { class: `lot-cards cols-${cols}` }, groups.map(([c, n]) => miniCard(c, n)));
  const only = !groups.length && abris > 0;      // 0 carte de ce côté : le badge doré occupe seul le camp, centré
  return el("div", { class: "side lot" + (only ? " abris-only" : "") },
    el("span", { class: "side-label" }, groups.length || !only ? `${label} · ${cards.length}` : label),
    groups.length ? grid : null,
    abris > 0 ? el("span", { class: "abris-badge" + (only ? " big" : "") }, icon("coin", only ? 18 : 13), `+${fmtNum(abris)} ${CURRENCY}`) : null);
}

// "ADN ×2, César + 30 Abri$"
function lotText(cards, abris) {
  const parts = groupCards(cards.map((c) => cardFromServer(c.id, c.rarete))).map(([c, n]) => n > 1 ? `${c.titre} ×${n}` : c.titre);
  if (abris > 0) parts.push(`${fmtNum(abris)} ${CURRENCY}`);
  return parts.join(" + ") || "rien";
}

/* --- Proposer un échange --- */

function showTradeModal(pseudo, requestedId = null) {
  const mine = ownedCards(me.owned);
  const theirs = ownedCards(ui.visit.data.owned);
  ui.modal = null;
  ui.tq = { mine: "", theirs: "" };
  ui.trade = {
    to: pseudo, mine, theirs,
    offered: [],                                   // ids, un id par exemplaire (doublons possibles)
    requested: requestedId && theirs.some((c) => c.id === requestedId) ? [requestedId] : [],
    give: 0, ask: 0,                               // Abri$ : un seul des deux peut être > 0
  };
  renderTradeModal();
}

function renderTradeModal() {
  const t = ui.trade;
  if (!t) return;
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const theirOwned = ui.visit.data.owned;
  const theirAbris = ui.visit.data.abris || 0;
  const countOf = (arr, id) => arr.reduce((n, x) => n + (x === id ? 1 : 0), 0);
  const toLot = (ids) => ids.map((id) => ({ id, rarete: byId.has(id) ? byId.get(id).rarity.key : null }));

  /* résumé en direct */
  const makeDuel = () => el("div", { class: "swap duel lots" },
    lotView(toLot(t.offered), t.give, "Tu donnes"),
    el("span", { class: "arrow" }, icon("swap", 24)),
    lotView(toLot(t.requested), t.ask, "Tu reçois"));
  let duel = makeDuel();

  // chaque camp donne quelque chose (carte ou Abri$), avec au moins 1 carte dans l'échange
  const sendBtn = el("button", { class: "primary", type: "button", onclick: sendTrade }, "Envoyer la proposition");
  const refresh = () => {
    const d = makeDuel(); duel.replaceWith(d); duel = d;
    pickers.forEach((p) => p.update());
    sendBtn.disabled = !tradeValid(t);
  };

  /* sélecteur : toucher une carte = +1 exemplaire ; boutons − / + ; 5 cartes max par camp */
  const pickers = [];
  const picker = (qKey, label, cards, owned, field) => {
    const q = el("input", {
      class: "pick-q", type: "search", autocomplete: "off", spellcheck: "false",
      placeholder: "Filtrer par nom ou rareté…", "aria-label": `Filtrer : ${label}`, value: ui.tq[qKey],
    });
    const gridBox = el("div", { class: "pick-grid" });
    const counter = el("span", { class: "pick-counter" });
    let rendered = [];

    const add = (c, d) => {
      const n = countOf(t[field], c.id);
      if (d > 0) {
        if (t[field].length >= MAX_TRADE_CARDS) return toast(`Maximum ${MAX_TRADE_CARDS} cartes par camp.`);
        if (n >= (owned[c.id] || 0)) return toast(`${field === "offered" ? "Tu n'en as" : t.to + " n'en a"} que ×${owned[c.id]} : « ${c.titre} ».`);
        t[field].push(c.id);
      } else if (n > 0) {
        t[field].splice(t[field].lastIndexOf(c.id), 1);
      }
      refresh();
    };

    const update = () => {
      counter.textContent = `${t[field].length}/${MAX_TRADE_CARDS}`;
      counter.classList.toggle("full", t[field].length >= MAX_TRADE_CARDS);
      rendered.forEach(({ c, node, num, minus, plus }) => {
        const n = countOf(t[field], c.id);
        node.classList.toggle("sel", n > 0);
        num.textContent = String(n);
        minus.disabled = n === 0;
        plus.disabled = n >= (owned[c.id] || 0) || t[field].length >= MAX_TRADE_CARDS;
      });
    };

    const paint = () => {
      const needle = norm(ui.tq[qKey]);
      const list = cards.filter((c) => !needle || norm(`${c.titre} ${c.rarity.label}`).includes(needle));
      rendered = list.map((c) => {
        const hit = el("button", { class: "pick-hit", type: "button", "aria-label": `Ajouter ${c.titre}` },
          cardFace(c), owned[c.id] > 1 ? el("span", { class: "count" }, `×${owned[c.id]}`) : null);
        const minus = el("button", { class: "qty-btn", type: "button", "aria-label": `Retirer un exemplaire de ${c.titre}` }, icon("minus", 14));
        const plus = el("button", { class: "qty-btn", type: "button", "aria-label": `Ajouter un exemplaire de ${c.titre}` }, icon("plus", 14));
        const num = el("b", { class: "qty-n" }, "0");
        const node = el("div", { class: "pick-card", "data-id": c.id }, hit, el("div", { class: "pick-qty" }, minus, num, plus));
        hit.addEventListener("click", () => add(c, 1));
        plus.addEventListener("click", () => add(c, 1));
        minus.addEventListener("click", () => add(c, -1));
        return { c, node, num, minus, plus };
      });
      gridBox.replaceChildren(...(rendered.length ? rendered.map((r) => r.node)
        : [el("p", { class: "muted small empty-grid" }, "Aucune carte ne correspond.")]));
      update();
    };
    q.addEventListener("input", () => { ui.tq[qKey] = q.value; paint(); });
    paint();
    pickers.push({ update });
    return el("div", { class: "pick" },
      el("div", { class: "pick-head" }, el("strong", {}, label), counter),
      el("label", { class: "pick-search" }, icon("search", 16), q),
      gridBox,
      el("p", { class: "muted small pick-help" }, "Touche une carte pour l'ajouter ; + / − pour les doubles."));
  };

  /* Abri$ : un seul côté à la fois (saisir un montant d'un côté remet l'autre à 0) */
  const myMax = me.abris, hisMax = theirAbris;
  const inputs = {};
  const abrisRow = (key, label, max, owner) => {
    const inp = el("input", {
      class: "abris-in", type: "number", inputmode: "numeric", min: "0", max: String(max), step: "1",
      placeholder: "0", "aria-label": label,
    });
    inputs[key] = inp;
    const row = el("label", { class: "abris-row" },
      el("span", { class: "abris-label" }, label, el("small", { class: "muted" }, ` · solde de ${owner} : ${money(max)}`)),
      el("span", { class: "abris-field" }, icon("coin", 16), inp));
    inp.addEventListener("input", () => {
      let v = parseInt(inp.value, 10);
      if (!Number.isFinite(v) || v < 0) v = 0;
      if (v > max) { v = max; inp.value = String(max); }
      t[key] = v;
      if (v > 0) {
        const other = key === "give" ? "ask" : "give";
        t[other] = 0;
        inputs[other].value = "";
      }
      row.classList.toggle("on", v > 0);
      Object.entries(inputs).forEach(([k, i]) => i.closest(".abris-row").classList.toggle("on", t[k] > 0));
      refresh();
    });
    return row;
  };
  const abrisBox = el("div", { class: "abris-box" },
    el("div", { class: "pick-head" }, el("strong", {}, "Abri$ en plus"), el("span", { class: "muted small" }, "un seul côté à la fois")),
    abrisRow("give", "Ajouter des Abri$ à mon offre", myMax, "toi"),
    abrisRow("ask", "Demander des Abri$ en plus", hisMax, t.to));

  const none = (txt) => el("p", { class: "muted small center no-cards" }, txt);
  const body = !t.mine.length && !t.theirs.length
    ? emptyState("booster", "Rien à échanger", "Ni toi ni " + t.to + " n'avez encore de carte.")
    : [
        duel,
        t.mine.length ? picker("mine", "Je donne", t.mine, me.owned, "offered") : none("Tu n'as aucune carte à donner : propose des Abri$ contre ses cartes."),
        t.theirs.length ? picker("theirs", `Je veux (de ${t.to})`, t.theirs, theirOwned, "requested") : none(`${t.to} n'a aucune carte : demande-lui des Abri$ contre tes cartes.`),
        abrisBox,
        el("p", { class: "muted small center" }, "Cartes contre cartes, ou cartes contre Abri$ (d'un seul côté). L'échange ne se fait que si " + t.to + " accepte."),
      ];

  const ready = t.mine.length > 0 || t.theirs.length > 0;
  const box = el("div", { class: "modal-box trade-modal", role: "dialog", "aria-label": "Proposer un échange" },
    el("button", { class: "modal-x", type: "button", "aria-label": "Fermer", onclick: closeModal }, icon("close", 20)),
    el("h2", { class: "section-title center" }, `Échange avec ${t.to}`),
    body,
    ready ? sendBtn : null,
    el("button", { class: "secondary", onclick: closeModal }, "Annuler")
  );
  $modal.replaceChildren(
    el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } }, box)
  );
  if (ready) refresh();
}

const tradeValid = (t) =>
  (t.offered.length + (t.give > 0 ? 1 : 0)) >= 1 &&
  (t.requested.length + (t.ask > 0 ? 1 : 0)) >= 1 &&
  t.offered.length + t.requested.length >= 1;

async function sendTrade() {
  const t = ui.trade;
  if (ui.busy || !t || !tradeValid(t)) return;
  ui.busy = true;
  try {
    await rpc("propose_trade", {
      p_to_pseudo: t.to, p_offered_cards: t.offered, p_requested_cards: t.requested,
      p_offered_abris: t.give, p_requested_abris: t.ask,
    });
    toast(`Proposition envoyée à ${t.to}.`);
    closeModal();
    ui.visit = null;
    ui.friendsTab = "trades";
  } catch (err) {
    toast(friendlyError(err));
  }
  ui.busy = false;
  await refreshSocial();
}

/* --- Espace Échanges : reçus, envoyés, historique --- */

function swapRow(giveCards, giveAbris, getCards, getAbris) {
  return el("div", { class: "swap duel lots" },
    lotView(giveCards, giveAbris, "Tu donnes"),
    el("span", { class: "arrow" }, icon("swap", 24)),
    lotView(getCards, getAbris, "Tu reçois"));
}

function viewTrades() {
  const incoming = social.tradesIn.map((t) =>
    el("div", { class: "trade" },
      el("div", { class: "trade-top" }, avatar(t.from),
        el("p", { class: "trade-head" }, el("strong", {}, t.from), " te propose un échange"),
        el("span", { class: "badge reply" }, "À toi de répondre")),
      // offered = ce que l'ami donne (tu le reçois) ; requested = ce qu'il veut (tu le donnes)
      swapRow(t.requested_cards, t.requested_abris, t.offered_cards, t.offered_abris),
      t.can_accept ? null : el("p", { class: "warning" }, icon("alert", 15), "Échange impossible pour le moment : des cartes ou des Abri$ ne sont plus disponibles."),
      el("div", { class: "trade-actions" },
        el("button", { class: "btn-sm", disabled: t.can_accept ? null : "", onclick: () => acceptTrade(t.id) }, "Accepter"),
        el("button", { class: "btn-sm ghost", onclick: () => declineTrade(t.id) }, "Refuser"))));

  const outgoing = social.tradesOut.map((t) =>
    el("div", { class: "trade" },
      el("div", { class: "trade-top" }, avatar(t.to),
        el("p", { class: "trade-head" }, "Proposition à ", el("strong", {}, t.to)),
        el("span", { class: "badge wait" }, "En attente")),
      swapRow(t.offered_cards, t.offered_abris, t.requested_cards, t.requested_abris),
      el("div", { class: "trade-actions" },
        el("button", { class: "btn-sm ghost", onclick: () => cancelTrade(t.id) }, "Annuler la proposition"))));

  // historique : détail complet des deux lots (cartes, quantités, Abri$)
  const history = social.history.map((h) => {
    const other = h.i_am_sender ? h.to : h.from;
    const give = h.i_am_sender ? [h.offered_cards, h.offered_abris] : [h.requested_cards, h.requested_abris];
    const get = h.i_am_sender ? [h.requested_cards, h.requested_abris] : [h.offered_cards, h.offered_abris];
    const ok = h.status === "accepted";
    return el("div", { class: "hist " + (ok ? "ok" : "ko") },
      icon(ok ? "check" : "close", 15),
      el("div", { class: "hist-body" },
        el("strong", {}, other), el("span", { class: "muted" }, ok ? " · accepté" : " · refusé"),
        el("div", { class: "hist-line" }, el("span", { class: "muted" }, "Tu donnes : "), lotText(...give)),
        el("div", { class: "hist-line" }, el("span", { class: "muted" }, "Tu reçois : "), lotText(...get))));
  });

  return el("div", {},
    el("h2", { class: "section-title" }, `Propositions reçues (${incoming.length})`),
    incoming.length ? incoming : emptyState("swap", "Aucune proposition reçue", "Tes amis peuvent t'en envoyer depuis ton profil."),
    el("h2", { class: "section-title" }, `Mes propositions envoyées (${outgoing.length})`),
    outgoing.length ? outgoing : emptyState("userplus", "Aucune proposition envoyée", "Ouvre le profil d'un ami pour lui proposer un échange."),
    history.length ? [el("h2", { class: "section-title" }, "Derniers échanges"), history] : null
  );
}

/* ---------- Boucle de temps (recharge des boosters) ---------- */

function tick() {
  if (!me) return;
  const gained = syncBoosters(me);
  if (gained > 0) {
    toast(`Nouveau booster disponible${gained > 1 ? ` (+${gained})` : ""} !`);
    if (!ui.opening && !ui.busy) render();
    refreshProfile();   // confirme avec le serveur
  }
  const left = fmtClock(msToNextBooster(me));
  document.querySelectorAll("[data-countdown]").forEach((n) => { n.textContent = left; });
  tickDaily();
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
  // Toutes les minutes : nouvelles demandes, échanges acceptés par un ami, etc.
  setInterval(() => { if (me && !document.hidden) { refreshProfile(); refreshSocial(); } }, 60000);
  // Retour sur l'app (ou depuis un autre appareil) : on se resynchronise avec le serveur
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshProfile({ force: true }); refreshSocial(); }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !window.__CARDS__) {
    // Recharge UNE fois quand une nouvelle version du service worker prend le contrôle.
    // Pas de rechargement à la toute première installation (aucun contrôleur avant).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    // Le rechargement se fait quand l'app est en arrière-plan : jamais d'écran « Chargement… » en pleine utilisation
    let pendingReload = false;
    const reloadNow = () => { if (reloading) return; reloading = true; window.location.reload(); };
    document.addEventListener("visibilitychange", () => { if (document.hidden && pendingReload) reloadNow(); });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      if (document.hidden) reloadNow(); else pendingReload = true;
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => {
        // Cherche une nouvelle version au retour sur l'app et toutes les 30 min
        const check = () => { if (reg) reg.update().catch(() => {}); };
        document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
        setInterval(check, 30 * 60 * 1000);
      })
      .catch((e) => console.warn("SW:", e));
  }
}

start();
