-- Généré par tools/cards_to_sql.py : ne pas modifier à la main.
insert into public.cards (id, rarete) values
  ('einstein', 'divin'),
  ('cesar', 'legendaire'),
  ('trou-noir', 'epique'),
  ('pyramide', 'rare'),
  ('adn', 'rare'),
  ('france', 'peu-commun'),
  ('gravite', 'commun'),
  ('cellule', 'commun')
on conflict (id) do update set rarete = excluded.rarete;

-- Retire du tirage les cartes supprimées de cards.json
delete from public.cards where id not in ('einstein', 'cesar', 'trou-noir', 'pyramide', 'adn', 'france', 'gravite', 'cellule');
