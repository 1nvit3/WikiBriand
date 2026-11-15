-- Généré par tools/cards_to_sql.py : ne pas modifier à la main.
insert into public.cards (id, rarete) values
  ('bat_coeur', 'commun'),
  ('bus_h1', 'peu-commun'),
  ('spe_nsi', 'rare'),
  ('bat_m_aero', 'epique'),
  ('opt_maths_expertes', 'legendaire'),
  ('event_blocus', 'divin')
on conflict (id) do update set rarete = excluded.rarete;

-- Retire du tirage les cartes supprimées de cards.json
delete from public.cards where id not in ('bat_coeur', 'bus_h1', 'spe_nsi', 'bat_m_aero', 'opt_maths_expertes', 'event_blocus');
