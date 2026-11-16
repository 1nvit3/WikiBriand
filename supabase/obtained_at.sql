-- =====================================================================
-- Collecto : date d'obtention des cartes (tri "Obtention")
-- À exécuter APRÈS schema.sql, social.sql, admin.sql et achievements.sql.
-- Script incrémental et relançable. Les fonctions ci-dessous sont les versions
-- existantes + uniquement les lignes "obtained_at". Rien d'autre ne change.
-- =====================================================================

-- 1) Colonne : { "id-de-carte": epoch_ms } (date de la PREMIÈRE obtention)
alter table public.profiles
  add column if not exists obtained_at jsonb not null default '{}'::jsonb;

-- 2) Migration : les cartes déjà possédées reçoivent la date de création du compte
--    (on ne connaît pas leur vraie date). Les dates déjà présentes sont conservées.
update public.profiles p
   set obtained_at = coalesce((
         select jsonb_object_agg(
                  e.key,
                  coalesce(p.obtained_at -> e.key, to_jsonb((extract(epoch from p.created_at) * 1000)::bigint)))
           from jsonb_each_text(p.owned) e
          where e.value::integer > 0
       ), '{}'::jsonb);

-- 3) Outil : date maintenant les cartes présentes dans new_owned mais absentes de old_owned
create or replace function private.obtained_stamp(obt jsonb, old_owned jsonb, new_owned jsonb)
returns jsonb
language sql
volatile
as $$
  select coalesce(obt, '{}'::jsonb) || coalesce((
    select jsonb_object_agg(e.key, (extract(epoch from clock_timestamp()) * 1000)::bigint)
      from jsonb_each_text(new_owned) e
     where e.value::integer > 0 and coalesce((old_owned ->> e.key)::integer, 0) = 0
  ), '{}'::jsonb);
$$;
revoke all on function private.obtained_stamp(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- 4) Profil renvoyé aux clients (+ obtained_at)
create or replace function private.profile_json(p public.profiles)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'pseudo',        p.pseudo,
    'abris',         p.abris,
    'boosters',      p.boosters,
    'owned',         p.owned,
    'obtained_at',   p.obtained_at,
    'last_tick_ms',  (extract(epoch from p.last_tick) * 1000)::bigint,
    'server_now_ms', (extract(epoch from now()) * 1000)::bigint
  );
$$;

-- 5) Tirages et échanges
create or replace function public.open_booster()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  booster_size constant integer := 5;
  max_boosters constant integer := 5;
  v_total numeric;
  v_roll  numeric;
  v_acc   numeric;
  v_rar   text;
  v_card  text;
  v_prev  integer;
  v_cards jsonb := '[]'::jsonb;
  rec record;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  p := private.regen(uid);
  if p.boosters <= 0 then raise exception 'no_booster'; end if;

  -- Seules les raretés qui ont au moins une carte peuvent être tirées
  select coalesce(sum(r.weight), 0) into v_total
    from public.rarities r
   where exists (select 1 from public.cards c where c.rarete = r.rarete);
  if v_total = 0 then raise exception 'no_cards'; end if;

  -- Le compteur d'une heure démarre quand le stock passe sous le maximum
  if p.boosters >= max_boosters then
    p.last_tick := now();
  end if;
  p.boosters := p.boosters - 1;

  for i in 1..booster_size loop
    v_roll := random() * v_total;
    v_acc  := 0;
    v_rar  := null;
    for rec in
      select r.rarete, r.weight
        from public.rarities r
       where exists (select 1 from public.cards c where c.rarete = r.rarete)
       order by r.weight desc, r.rarete
    loop
      v_acc := v_acc + rec.weight;
      v_rar := rec.rarete;
      exit when v_roll < v_acc;
    end loop;

    select c.id into v_card
      from public.cards c
     where c.rarete = v_rar
     order by random()
     limit 1;

    v_prev := coalesce((p.owned ->> v_card)::integer, 0);
    if v_prev = 0 then   -- première obtention : on date, sinon on garde la date d'origine
      p.obtained_at := jsonb_set(p.obtained_at, array[v_card], to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), true);
    end if;
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(
      jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0)
    );
  end loop;

  update public.profiles
     set boosters = p.boosters, last_tick = p.last_tick, owned = p.owned, obtained_at = p.obtained_at
   where id = uid;

  return private.profile_json(p) || jsonb_build_object('cards', v_cards);
end;
$$;

create or replace function public.admin_open_booster(p_force_rarity text default null, p_luck numeric default 1)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  v_luck  numeric := least(greatest(coalesce(p_luck, 1), 1), 1000);
  v_total numeric;
  v_roll  numeric;
  v_acc   numeric;
  v_rar   text;
  v_card  text;
  v_prev  integer;
  v_cards jsonb := '[]'::jsonb;
  rec record;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not private.is_admin(uid) then raise exception 'unauthorized'; end if;

  p := private.regen(uid);

  if p_force_rarity is not null and not exists (
       select 1 from public.cards c where c.rarete = p_force_rarity) then
    raise exception 'invalid_rarity';
  end if;

  select coalesce(sum(case when r.rarete = 'commun' then r.weight else r.weight * v_luck end), 0)
    into v_total
    from public.rarities r
   where exists (select 1 from public.cards c where c.rarete = r.rarete);
  if v_total = 0 then raise exception 'no_cards'; end if;

  for i in 1..5 loop
    if p_force_rarity is not null then
      v_rar := p_force_rarity;
    else
      v_roll := random() * v_total;
      v_acc  := 0;
      v_rar  := null;
      for rec in
        select r.rarete,
               case when r.rarete = 'commun' then r.weight else r.weight * v_luck end as w
          from public.rarities r
         where exists (select 1 from public.cards c where c.rarete = r.rarete)
         order by 2 desc, r.rarete
      loop
        v_acc := v_acc + rec.w;
        v_rar := rec.rarete;
        exit when v_roll < v_acc;
      end loop;
    end if;

    select c.id into v_card from public.cards c where c.rarete = v_rar order by random() limit 1;

    v_prev := coalesce((p.owned ->> v_card)::integer, 0);
    if v_prev = 0 then
      p.obtained_at := jsonb_set(p.obtained_at, array[v_card], to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), true);
    end if;
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(
      jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0));
  end loop;

  update public.profiles set owned = p.owned, obtained_at = p.obtained_at where id = uid;

  return private.profile_json(p) || jsonb_build_object('cards', v_cards);
end;
$$;

create or replace function public.accept_trade(p_trade_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  t public.trades;
  s public.profiles;   -- expéditeur
  r public.profiles;   -- toi (destinataire)
  s_new jsonb;
  r_new jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into t from public.trades where id = p_trade_id for update;
  if not found or t.receiver_id <> uid then raise exception 'trade_not_found'; end if;
  if t.status <> 'pending' then raise exception 'trade_not_pending'; end if;
  if not private.are_friends(t.sender_id, t.receiver_id) then raise exception 'not_friends'; end if;

  -- On verrouille les deux profils toujours dans le même ordre (évite les blocages croisés)
  perform private.regen(least(t.sender_id, t.receiver_id));
  perform private.regen(greatest(t.sender_id, t.receiver_id));
  select * into s from public.profiles where id = t.sender_id;
  select * into r from public.profiles where id = t.receiver_id;

  if coalesce((s.owned ->> t.offered_card_id)::integer, 0) < 1 then raise exception 'sender_lacks_card'; end if;
  if coalesce((r.owned ->> t.requested_card_id)::integer, 0) < 1 then raise exception 'you_lack_card'; end if;

  s_new := private.owned_add(private.owned_add(s.owned, t.offered_card_id, -1), t.requested_card_id, 1);
  r_new := private.owned_add(private.owned_add(r.owned, t.requested_card_id, -1), t.offered_card_id, 1);
  -- date uniquement pour les cartes qu'on ne possédait pas encore
  s.obtained_at := private.obtained_stamp(s.obtained_at, s.owned, s_new);
  r.obtained_at := private.obtained_stamp(r.obtained_at, r.owned, r_new);
  s.owned := s_new;
  r.owned := r_new;

  update public.profiles set owned = s.owned, obtained_at = s.obtained_at where id = s.id;
  update public.profiles set owned = r.owned, obtained_at = r.obtained_at where id = r.id;
  update public.trades set status = 'accepted' where id = t.id;

  return private.profile_json(r);
end;
$$;

-- 6) Remise à zéro
create or replace function public.reset_collection()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  p := private.regen(uid);
  p.owned := '{}'::jsonb;
  p.obtained_at := '{}'::jsonb;
  update public.profiles set owned = p.owned, obtained_at = p.obtained_at where id = uid;
  return private.profile_json(p);
end;
$$;
