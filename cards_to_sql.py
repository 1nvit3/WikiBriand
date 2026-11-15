#!/usr/bin/env python3
"""Génère supabase/seed_cards.sql à partir de cards.json.

À relancer chaque fois que tu ajoutes, retires ou changes la rareté d'une carte :

    python3 tools/cards_to_sql.py

Puis copie le contenu de supabase/seed_cards.sql dans Supabase > SQL Editor et exécute-le.
Le serveur n'a besoin que de l'id et de la rareté de chaque carte pour tirer les boosters.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RARITIES = {"commun", "peu-commun", "rare", "epique", "legendaire", "divin"}


def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[\s_]+", "-", s.lower().strip())


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


cards = json.loads((ROOT / "cards.json").read_text(encoding="utf-8"))["cards"]
rows, seen, errors = [], set(), []

for i, c in enumerate(cards, start=1):
    cid, rar = c.get("id"), norm(c.get("rarete"))
    if not cid:
        errors.append(f"carte n°{i} : id manquant")
    elif cid in seen:
        errors.append(f"carte {cid} : id en double")
    elif rar not in RARITIES:
        errors.append(f"carte {cid} : rareté inconnue ({c.get('rarete')!r})")
    else:
        seen.add(cid)
        rows.append((cid, rar))

if errors:
    print("Erreurs dans cards.json :\n - " + "\n - ".join(errors), file=sys.stderr)
    sys.exit(1)

values = ",\n  ".join(f"({lit(cid)}, {lit(rar)})" for cid, rar in rows)
ids = ", ".join(lit(cid) for cid, _ in rows)

sql = f"""-- Généré par tools/cards_to_sql.py : ne pas modifier à la main.
insert into public.cards (id, rarete) values
  {values}
on conflict (id) do update set rarete = excluded.rarete;

-- Retire du tirage les cartes supprimées de cards.json
delete from public.cards where id not in ({ids});
"""

out = ROOT / "supabase" / "seed_cards.sql"
out.parent.mkdir(exist_ok=True)
out.write_text(sql, encoding="utf-8")
print(f"{len(rows)} cartes -> {out.relative_to(ROOT)}")
