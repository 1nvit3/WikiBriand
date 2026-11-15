-- =====================================================================
-- Collecto : Succès (achievements) + Classement   (à exécuter APRÈS schema.sql et social.sql)
-- Script incrémental : peut être relancé sans danger. Ne modifie aucune RPC existante.
-- =====================================================================

alter table public.profiles
  add column if not exists claimed_achievements jsonb not null default '[]'::jsonb;

-- Catalogue des succès : SEULE source de vérité (conditions + récompenses).
create or replace function private.ach_defs()
returns table (id text, target integer, reward integer)
language sql
stable
set search_path = public
as $$
  select * from (values
    ('unique_3',        3,    50),
    ('unique_5',        5,    150),
    ('complete_all',    greatest((select count(*)::integer from public.cards), 1), 1000),
    ('have_legendaire', 1,    300),
    ('have_divin',      1,    1000),
    ('rich_1000',       1000, 100),
    ('friend_1',        1,    50),
    ('friend_3',        3,    150)
  ) as t (id, target, reward);
$$;

-- Progression actuelle d'un joueur pour un succès.
create or replace function private.ach_progress(p_uid uuid, p_id text)
returns integer
language plpgsql
stable
set search_path = public
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_uid;
  if not found then return 0; end if;

  return case p_id
    when 'unique_3'     then private.ach_unique(p.owned)
    when 'unique_5'     then private.ach_unique(p.owned)
    when 'complete_all' then private.ach_unique(p.owned)
    when 'have_legendaire' then private.ach_has_rarity(p.owned, 'legendaire')
    when 'have_divin'      then private.ach_has_rarity(p.owned, 'divin')
    when 'rich_1000'    then p.abris
    when 'friend_1'     then private.ach_friends(p_uid)
    when 'friend_3'     then private.ach_friends(p_uid)
    else 0
  end;
end;
$$;

create or replace function private.ach_unique(p_owned jsonb)
returns integer language sql stable set search_path = public as $$
  select count(*)::integer
    from jsonb_each_text(p_owned) e
    join public.cards c on c.id = e.key
   where e.value::integer > 0;
$$;

create or replace function private.ach_has_rarity(p_owned jsonb, p_rarete text)
returns integer language sql stable set search_path = public as $$
  select count(*)::integer
    from jsonb_each_text(p_owned) e
    join public.cards c on c.id = e.key
   where e.value::integer > 0 and c.rarete = p_rarete;
$$;

create or replace function private.ach_friends(p_uid uuid)
returns integer language sql stable set search_path = public as $$
  select count(*)::integer from public.friendships f
   where f.status = 'accepted' and p_uid in (f.user_id, f.friend_id);
$$;

-- Liste des succès avec la progression (plafonnée à l'objectif) et l'état « réclamé ».
create or replace function public.list_achievements()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  claimed jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select claimed_achievements into claimed from public.profiles where id = uid;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id,
             'target', d.target,
             'reward', d.reward,
             'progress', least(private.ach_progress(uid, d.id), d.target),
             'claimed', coalesce(claimed, '[]'::jsonb) ? d.id)
           order by d.reward)
      from private.ach_defs() d
  ), '[]'::jsonb);
end;
$$;

-- Réclame un succès : vérifie la condition, crédite les Abri$, empêche le doublon.
create or replace function public.claim_achievement(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  d record;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into p from public.profiles where id = uid for update;   -- verrou : pas de double clic
  select * into d from private.ach_defs() x where x.id = p_id;
  if not found then raise exception 'unknown_achievement'; end if;
  if p.claimed_achievements ? p_id then raise exception 'already_claimed'; end if;
  if private.ach_progress(uid, p_id) < d.target then raise exception 'not_unlocked'; end if;

  update public.profiles
     set abris = abris + d.reward,
         claimed_achievements = claimed_achievements || to_jsonb(p_id)
   where id = uid;

  return public.get_profile();
end;
$$;

-- Top 15 : cartes uniques, puis valeur de revente de la collection. Aucune donnée sensible
-- (ni Abri$, ni id, ni liste de cartes). "me" = ton rang même hors du top 15.
create or replace function public.get_leaderboard()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  res jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  with stats as (
    select p.id, p.pseudo,
           count(*) filter (where o.qty > 0 and c.id is not null)::integer          as unique_owned,
           coalesce(sum(o.qty * r.sell) filter (where o.qty > 0), 0)::integer        as value,
           coalesce(sum(o.qty) filter (where c.rarete in ('legendaire', 'divin')), 0)::integer as top_cards
      from public.profiles p
      left join lateral (select e.key as cid, e.value::integer as qty from jsonb_each_text(p.owned) e) o on true
      left join public.cards c on c.id = o.cid
      left join public.rarities r on r.rarete = c.rarete
     group by p.id, p.pseudo
  ), ranked as (
    select s.*, row_number() over (order by s.unique_owned desc, s.value desc, lower(s.pseudo)) as rank
      from stats s
  )
  select jsonb_build_object(
           'top', coalesce((select jsonb_agg(jsonb_build_object(
                     'rank', rank, 'pseudo', pseudo, 'unique_owned', unique_owned,
                     'value', value, 'top_cards', top_cards) order by rank)
                   from ranked where rank <= 15), '[]'::jsonb),
           'me', (select jsonb_build_object(
                     'rank', rank, 'pseudo', pseudo, 'unique_owned', unique_owned,
                     'value', value, 'top_cards', top_cards)
                   from ranked where id = uid),
           'total_cards', (select count(*) from public.cards),
           'players', (select count(*) from ranked))
    into res;
  return res;
end;
$$;

revoke all on function private.ach_defs()                 from public, anon, authenticated;
revoke all on function private.ach_progress(uuid, text)   from public, anon, authenticated;
revoke all on function private.ach_unique(jsonb)          from public, anon, authenticated;
revoke all on function private.ach_has_rarity(jsonb, text) from public, anon, authenticated;
revoke all on function private.ach_friends(uuid)          from public, anon, authenticated;
revoke all on function public.list_achievements()         from public, anon;
revoke all on function public.claim_achievement(text)     from public, anon;
revoke all on function public.get_leaderboard()           from public, anon;
grant execute on function public.list_achievements()      to authenticated;
grant execute on function public.claim_achievement(text)  to authenticated;
grant execute on function public.get_leaderboard()        to authenticated;
