// Configuration Supabase de Collecto.
//
// Où trouver ces deux valeurs : Supabase > Project Settings > API
//   - Project URL
//   - clé "anon" (ou "publishable") : cette clé est PUBLIQUE par conception, elle peut
//     rester dans le code sur GitHub. La sécurité vient des règles côté base (RLS + fonctions).
//
// Ne mets JAMAIS ici la clé "service_role" (ou "secret") : elle donne tous les droits.
window.COLLECTO_CONFIG = {
  SUPABASE_URL: "https://lxloqenionpqcwzwqrca.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_9E9HJ2H9_Tvo2OM8xAvFJw_ERyvI062",

  // Options (à ne changer que si besoin) :
  // Supabase veut une adresse e-mail pour chaque compte : on en fabrique une à partir du pseudo
  // (pseudo@EMAIL_DOMAIN). Aucun e-mail n'est jamais envoyé. Si Supabase refuse ce domaine,
  // mets un domaine qui t'appartient.
  EMAIL_DOMAIN: "collecto.game",
  // Texte ajouté au PIN pour atteindre les 6 caractères minimum exigés par Supabase.
  // Ne le change plus une fois que des joueurs ont créé un compte, sinon plus personne ne peut se connecter.
  PIN_PEPPER: "-collecto",
};
