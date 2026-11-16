-- Généré par tools/cards_to_sql.py : ne pas modifier à la main.
insert into public.cards (id, rarete) values
  ('bat_coeur', 'commun'),
  ('bus_h1', 'peu-commun'),
  ('spe_nsi', 'rare'),
  ('bat_m_aero', 'legendaire'),
  ('opt_maths_expertes', 'epique'),
  ('event_blocus', 'divin'),
  ('bus_h2', 'peu-commun'),
  ('bus_l13', 'rare'),
  ('opt_sciences_ingenieur', 'rare'),
  ('bat_g', 'rare'),
  ('gym_nord', 'rare'),
  ('gym_leo', 'peu-commun'),
  ('es_svt', 'peu-commun'),
  ('es_pc', 'peu-commun')
on conflict (id) do update set rarete = excluded.rarete;

-- Retire du tirage les cartes supprimées de cards.json
delete from public.cards where id not in ('bat_coeur', 'bus_h1', 'spe_nsi', 'bat_m_aero', 'opt_maths_expertes', 'event_blocus', 'bus_h2', 'bus_l13', 'opt_sciences_ingenieur', 'bat_g', 'gym_nord', 'gym_leo', 'es_svt', 'es_pc');
