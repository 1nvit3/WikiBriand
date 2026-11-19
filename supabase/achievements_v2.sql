-- =====================================================================
-- WikiBrand v1.6 : succès à paliers (Palier I, II, III...) et nouveaux succès
-- À exécuter APRÈS achievements.sql et shop_and_settings.sql (qui ajoute profiles.shop_bought).
-- Script relançable. Les 8 identifiants de succès existants sont CONSERVÉS (unique_3, unique_5,
-- complete_all, have_legendaire, have_divin, rich_1000, friend_1, friend_3) : les récompenses déjà
-- réclamées restent réclamées. claim_achievement(p_id) garde la même signature.
-- Les textes affichés sont dans app.js (ACH_GROUPS) ; ici : objectifs, récompenses, progression.
-- =====================================================================

alter table public.profiles add column if not exists shop_bought integer not null default 0;

drop function if exists private.ach_defs();

-- Catalogue : SEULE source de vérité.
--   grp    : famille de succès ; tier : numéro de palier (1, 2, 3...)
--   kind   : ce qui est mesuré ; arg : paramètre (ex. rareté)
create or replace function private.ach_defs()
returns table (id text, grp text, tier integer, kind text, arg text, target integer, reward integer)
language sql
stable
set search_path = public
as $$
  with n as (select greatest((select count(*)::integer from public.cards), 1) as cards)
  select * from (
    -- Collection : cartes différentes (paliers fixes puis en % du jeu)
    select 'unique_3',     'collection', 1, 'unique', null::text, 3,                                  50 from n union all
    select 'unique_5',     'collection', 2, 'unique', null,       5,                                  150 from n union all
    select 'unique_25p',   'collection', 3, 'unique', null,       least(greatest(ceil(n.cards * 0.25)::integer, 6), n.cards),  300 from n union all
    select 'unique_50p',   'collection', 4, 'unique', null,       least(greatest(ceil(n.cards * 0.50)::integer, 7), n.cards),  600 from n union all
    select 'unique_75p',   'collection', 5, 'unique', null,       least(greatest(ceil(n.cards * 0.75)::integer, 8), n.cards),  1000 from n union all
    select 'complete_all', 'collection', 6, 'unique', null,       n.cards,               2500 from n union all
    -- Cartes au total (doubles compris)
    select 'copies_25',    'copies', 1, 'copies', null, 25,   50 from n union all
    select 'copies_100',   'copies', 2, 'copies', null, 100,  200 from n union all
    select 'copies_300',   'copies', 3, 'copies', null, 300,  600 from n union all
    -- Raretés (objectif plafonné au nombre de cartes de cette rareté dans le jeu)
    select 'epic_3',       'epic', 1, 'rarity', 'epique', least(3, greatest((select count(*)::integer from public.cards c where c.rarete = 'epique'), 1)),  150 from n union all
    select 'epic_10',      'epic', 2, 'rarity', 'epique', least(10, greatest((select count(*)::integer from public.cards c where c.rarete = 'epique'), 1)), 500 from n union all
    select 'have_legendaire','legend', 1, 'rarity', 'legendaire', 1, 300 from n union all
    select 'legend_3',     'legend', 2, 'rarity', 'legendaire', least(3, greatest((select count(*)::integer from public.cards c where c.rarete = 'legendaire'), 1)), 800 from n union all
    select 'have_divin',   'divin', 1, 'rarity', 'divin', 1, 1000 from n union all
    select 'divin_3',      'divin', 2, 'rarity', 'divin', least(3, greatest((select count(*)::integer from public.cards c where c.rarete = 'divin'), 1)), 3000 from n union all
    -- Fortune : solde actuel en Abri$
    select 'rich_500',     'rich', 1, 'abris', null, 500,   50 from n union all
    select 'rich_1000',    'rich', 2, 'abris', null, 1000,  100 from n union all
    select 'rich_5000',    'rich', 3, 'abris', null, 5000,  400 from n union all
    select 'rich_20000',   'rich', 4, 'abris', null, 20000, 1500 from n union all
    -- Amis
    select 'friend_1',     'friends', 1, 'friends', null, 1,  50 from n union all
    select 'friend_3',     'friends', 2, 'friends', null, 3,  150 from n union all
    select 'friend_5',     'friends', 3, 'friends', null, 5,  250 from n union all
    select 'friend_10',    'friends', 4, 'friends', null, 10, 600 from n union all
    -- Échanges acceptés
    select 'trade_1',      'trades', 1, 'trades', null, 1,  100 from n union all
    select 'trade_5',      'trades', 2, 'trades', null, 5,  300 from n union all
    select 'trade_20',     'trades', 3, 'trades', null, 20, 1000 from n union all
    -- Boutique : boosters achetés
    select 'shop_1',       'shop', 1, 'shop', null, 1,  50 from n union all
    select 'shop_5',       'shop', 2, 'shop', null, 5,  200 from n union all
    select 'shop_20',      'shop', 3, 'shop', null, 20, 800 from n
  ) t (id, grp, tier, kind, arg, target, reward);
$$;

-- Progression exacte, calculée à partir de l'état courant du joueur.
create or replace function private.ach_progress(p_uid uuid, p_id text)
returns integer
language plpgsql
stable
set search_path = public
as $$
declare
  p public.profiles;
  d record;
begin
  select * into p from public.profiles where id = p_uid;
  if not found then return 0; end if;
  select * into d from private.ach_defs() x where x.id = p_id;
  if not found then return 0; end if;

  return case d.kind
    when 'unique'  then private.ach_unique(p.owned)
    when 'copies'  then coalesce((select sum(e.value::integer)::integer from jsonb_each_text(p.owned) e
                                   join public.cards c on c.id = e.key where e.value::integer > 0), 0)
    when 'rarity'  then private.ach_has_rarity(p.owned, d.arg)
    when 'abris'   then p.abris
    when 'friends' then private.ach_friends(p_uid)
    when 'trades'  then (select count(*)::integer from public.trades t
                          where t.status = 'accepted' and p_uid in (t.sender_id, t.receiver_id))
    when 'shop'    then p.shop_bought
    else 0
  end;
end;
$$;

-- Liste : progression plafonnée à l'objectif, état « réclamé ».
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
             'id', d.id, 'grp', d.grp, 'tier', d.tier, 'kind', d.kind,
             'target', d.target, 'reward', d.reward,
             'progress', least(private.ach_progress(uid, d.id), d.target),
             'claimed', coalesce(claimed, '[]'::jsonb) ? d.id)
           order by d.grp, d.tier)
      from private.ach_defs() d
  ), '[]'::jsonb);
end;
$$;

-- claim_achievement : inchangée (elle lit private.ach_defs() et private.ach_progress()).
-- On la recrée simplement pour être sûr qu'elle utilise les nouvelles versions.
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

revoke all on function private.ach_defs()               from public, anon, authenticated;
revoke all on function private.ach_progress(uuid, text) from public, anon, authenticated;
revoke all on function public.list_achievements()       from public, anon;
revoke all on function public.claim_achievement(text)   from public, anon;
grant execute on function public.list_achievements()    to authenticated;
grant execute on function public.claim_achievement(text) to authenticated;
