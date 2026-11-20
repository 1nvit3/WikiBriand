-- =====================================================================
-- WikiBrand v1.8 : Marché (offres du jour + offres entre joueurs)
-- À exécuter APRÈS market_cards.sql. Ordre complet :
--   schema, seed_cards, social, admin, achievements, obtained_at, trades_v2,
--   shop_and_settings, achievements_v2, shop_v2, market_cards, market_v2.
-- Script relançable.
--
-- OFFRES DU JOUR (changent à minuit, heure du serveur, tirage déterministe sur la date)
--   3 cartes à l'achat   : 75 % du prix dynamique de market_cards.sql
--   3 cartes à la reprise : le serveur te les rachète à 55 % de ce prix
--   (les deux ensembles sont disjoints, et 55 % < 75 % : aucun aller-retour rentable)
--   Chaque offre = 1 utilisation par joueur et par jour (table daily_deals_claims).
--
-- OFFRES ENTRE JOUEURS (public.player_listings)
--   'sell' : je mets une carte que je possède en vente pour X Abri$
--   'buy'  : je propose X Abri$ pour une carte précise
--   Max 5 offres ouvertes par joueur. Rien n'est bloqué à la création : à l'acceptation, le
--   serveur revérifie tout en tenant compte des cartes déjà engagées dans d'autres offres de
--   vente ouvertes et des Abri$ déjà engagés dans d'autres offres d'achat ouvertes.
--   Si l'auteur ne peut plus honorer son offre, elle est annulée et l'acceptant n'est pas débité.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Prix dynamiques de toutes les cartes (même formule que get_card_market)
-- ---------------------------------------------------------------------
create or replace function private.market_prices()
returns table (card_id text, rarete text, price integer)
language sql
stable
security definer
set search_path = public, private
as $$
  with tot as (select greatest(count(*), 1) as n from public.profiles),
       own as (
         select e.key as id, count(*) as n
           from public.profiles pr, jsonb_each_text(pr.owned) e
          where e.value ~ '^[0-9]+$' and e.value::integer > 0
          group by e.key)
  select c.id, c.rarete, private.card_price(c.rarete, coalesce(o.n, 0), (select n from tot))
    from public.cards c left join own o on o.id = c.id;
$$;
revoke all on function private.market_prices() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) Offres du jour
-- ---------------------------------------------------------------------
create table if not exists public.daily_deals_claims (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  day        date not null,
  kind       text not null check (kind in ('buy', 'sell')),
  card_id    text not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, day, kind, card_id)
);
alter table public.daily_deals_claims enable row level security;
revoke all on table public.daily_deals_claims from anon, authenticated;

-- les 6 cartes du jour : 3 'buy' (le joueur achète) puis 3 'sell' (le serveur reprend)
create or replace function private.daily_deals(p_day date)
returns table (kind text, card_id text, rarete text, base_price integer, price integer)
language sql
stable
security definer
set search_path = public, private
as $$
  with mp as (select * from private.market_prices()),
  b as (
    select 'buy'::text as kind, m.card_id, m.rarete, m.price as base_price,
           (((m.price::bigint * 75 + 999) / 1000) * 10)::integer as price          -- 75 %, dizaine supérieure
      from mp m order by md5(p_day::text || 'buy' || m.card_id) limit 3
  ),
  s as (
    select 'sell'::text as kind, m.card_id, m.rarete, m.price as base_price,
           greatest(((m.price::bigint * 55 / 100) / 10) * 10, 10)::integer as price  -- 55 %, dizaine inférieure
      from mp m where m.card_id not in (select card_id from b)
     order by md5(p_day::text || 'sell' || m.card_id) limit 3
  )
  select * from b union all select * from s;
$$;
revoke all on function private.daily_deals(date) from public, anon, authenticated;

create or replace function public.get_daily_market()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  v_day date := current_date;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  return jsonb_build_object(
    'day', v_day,
    'next_ms', (extract(epoch from ((v_day + 1)::timestamp at time zone current_setting('TimeZone'))) * 1000)::bigint,
    'server_now_ms', (extract(epoch from now()) * 1000)::bigint,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', d.kind, 'card_id', d.card_id, 'rarete', d.rarete,
               'base_price', d.base_price, 'price', d.price,
               'claimed', exists (select 1 from public.daily_deals_claims c
                                   where c.user_id = uid and c.day = v_day and c.kind = d.kind and c.card_id = d.card_id))
             order by d.kind desc, md5(v_day::text || d.kind || d.card_id))
        from private.daily_deals(v_day) d), '[]'::jsonb));
end;
$$;
revoke all on function public.get_daily_market() from public, anon;
grant execute on function public.get_daily_market() to authenticated;

-- cartes que le joueur a déjà engagées dans des offres de vente ouvertes (créée plus bas, forward-declared ici)
create table if not exists public.player_listings (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  side       text not null check (side in ('buy', 'sell')),
  card_id    text not null references public.cards(id) on delete cascade,
  price      integer not null check (price > 0 and price <= 10000000),
  status     text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at timestamptz not null default now(),
  filled_at  timestamptz,
  filled_by  uuid references public.profiles(id) on delete set null
);
create index if not exists player_listings_open_idx on public.player_listings (status, side, card_id);
create index if not exists player_listings_creator_idx on public.player_listings (creator_id, status);
alter table public.player_listings enable row level security;
revoke all on table public.player_listings from anon, authenticated;

create or replace function private.committed_cards(p_uid uuid, p_card text, p_except uuid default null)
returns integer language sql stable security definer set search_path = public, private as $$
  select count(*)::integer from public.player_listings
   where creator_id = p_uid and side = 'sell' and status = 'open' and card_id = p_card
     and id is distinct from p_except;
$$;
create or replace function private.committed_abris(p_uid uuid, p_except uuid default null)
returns bigint language sql stable security definer set search_path = public, private as $$
  select coalesce(sum(price), 0)::bigint from public.player_listings
   where creator_id = p_uid and side = 'buy' and status = 'open' and id is distinct from p_except;
$$;
revoke all on function private.committed_cards(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.committed_abris(uuid, uuid)       from public, anon, authenticated;

create or replace function public.claim_daily_offer(p_kind text, p_card_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  d record;
  v_day date := current_date;
  v_old jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('buy', 'sell') then raise exception 'invalid_kind'; end if;

  p := private.regen(uid);                                   -- verrouille le profil (FOR UPDATE)

  select * into d from private.daily_deals(v_day) x where x.kind = p_kind and x.card_id = p_card_id;
  if not found then raise exception 'offer_not_available'; end if;
  if exists (select 1 from public.daily_deals_claims c
              where c.user_id = uid and c.day = v_day and c.kind = p_kind and c.card_id = p_card_id) then
    raise exception 'already_claimed';
  end if;

  v_old := p.owned;
  if p_kind = 'buy' then
    if p.abris < d.price then raise exception 'not_enough_abris'; end if;
    p.abris := p.abris - d.price;
    p.owned := private.owned_add(p.owned, p_card_id, 1);
  else
    -- une carte engagée dans une de mes offres de vente ouvertes n'est pas disponible
    if coalesce((p.owned ->> p_card_id)::integer, 0) - private.committed_cards(uid, p_card_id) < 1 then
      raise exception 'card_not_owned';
    end if;
    p.abris := p.abris + d.price;
    p.owned := private.owned_add(p.owned, p_card_id, -1);
  end if;
  p.obtained_at := private.obtained_stamp(p.obtained_at, v_old, p.owned);

  insert into public.daily_deals_claims (user_id, day, kind, card_id) values (uid, v_day, p_kind, p_card_id);
  update public.profiles set abris = p.abris, owned = p.owned, obtained_at = p.obtained_at where id = uid;

  return jsonb_build_object('profile', private.profile_json(p), 'price', d.price, 'kind', p_kind, 'card_id', p_card_id);
end;
$$;
revoke all on function public.claim_daily_offer(text, text) from public, anon;
grant execute on function public.claim_daily_offer(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3) Offres entre joueurs
-- ---------------------------------------------------------------------
create or replace function public.list_player_offers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  return jsonb_build_object(
    'max_open', 5,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'side', l.side, 'card_id', l.card_id, 'rarete', c.rarete, 'price', l.price,
               'pseudo', pr.pseudo, 'mine', l.creator_id = uid,
               'created_ms', (extract(epoch from l.created_at) * 1000)::bigint)
             order by (l.creator_id = uid) desc, l.created_at desc)
        from (select * from public.player_listings
               where status = 'open'
               order by (creator_id = uid) desc, created_at desc limit 300) l
        join public.cards c on c.id = l.card_id
        join public.profiles pr on pr.id = l.creator_id), '[]'::jsonb));
end;
$$;
revoke all on function public.list_player_offers() from public, anon;
grant execute on function public.list_player_offers() to authenticated;

create or replace function public.create_player_offer(p_side text, p_card_id text, p_price integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  v_id uuid;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_side not in ('buy', 'sell') then raise exception 'invalid_side'; end if;
  if p_price is null or p_price <= 0 or p_price > 10000000 then raise exception 'invalid_price'; end if;
  if not exists (select 1 from public.cards where id = p_card_id) then raise exception 'unknown_card'; end if;

  p := private.regen(uid);                                   -- verrouille le profil : pas de course entre créations
  if (select count(*) from public.player_listings where creator_id = uid and status = 'open') >= 5 then
    raise exception 'too_many_offers';
  end if;

  if p_side = 'sell' then
    if coalesce((p.owned ->> p_card_id)::integer, 0) - private.committed_cards(uid, p_card_id) < 1 then
      raise exception 'card_not_owned';
    end if;
  else
    if p.abris - private.committed_abris(uid) < p_price then raise exception 'not_enough_abris'; end if;
  end if;

  insert into public.player_listings (creator_id, side, card_id, price) values (uid, p_side, p_card_id, p_price)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'profile', private.profile_json(p));
end;
$$;
revoke all on function public.create_player_offer(text, text, integer) from public, anon;
grant execute on function public.create_player_offer(text, text, integer) to authenticated;

create or replace function public.cancel_player_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  o public.player_listings;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into o from public.player_listings where id = p_offer_id for update;
  if not found then raise exception 'offer_not_found'; end if;
  if o.creator_id <> uid then raise exception 'not_your_offer'; end if;
  if o.status <> 'open' then raise exception 'offer_not_open'; end if;
  update public.player_listings set status = 'cancelled' where id = p_offer_id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.cancel_player_offer(uuid) from public, anon;
grant execute on function public.cancel_player_offer(uuid) to authenticated;

create or replace function public.accept_player_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  o public.player_listings;
  me public.profiles;
  other public.profiles;
  buyer public.profiles;
  seller public.profiles;
  v_ok boolean;
  v_old_b jsonb; v_old_s jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  select * into o from public.player_listings where id = p_offer_id for update;
  if not found then raise exception 'offer_not_found'; end if;
  if o.status <> 'open' then raise exception 'offer_not_open'; end if;
  if o.creator_id = uid then raise exception 'own_offer'; end if;

  -- verrouille les deux profils, toujours dans l'ordre des id (pas d'interblocage)
  perform 1 from public.profiles where id in (uid, o.creator_id) order by id for update;
  me := private.regen(uid);
  select * into other from public.profiles where id = o.creator_id;

  if o.side = 'sell' then buyer := me;    seller := other;
  else                    buyer := other; seller := me;
  end if;

  -- 1) ce que l'acceptant doit pouvoir faire : erreur (rien n'est modifié)
  if o.side = 'sell' then
    if me.abris < o.price then raise exception 'not_enough_abris'; end if;
  else
    if coalesce((me.owned ->> o.card_id)::integer, 0) - private.committed_cards(uid, o.card_id) < 1 then
      raise exception 'card_not_owned';
    end if;
  end if;

  -- 2) ce que l'auteur doit encore pouvoir faire : sinon l'offre est périmée, on l'annule
  if o.side = 'sell' then
    v_ok := coalesce((seller.owned ->> o.card_id)::integer, 0) - private.committed_cards(seller.id, o.card_id, o.id) >= 1;
  else
    v_ok := buyer.abris - private.committed_abris(buyer.id, o.id) >= o.price;
  end if;
  if not v_ok then
    update public.player_listings set status = 'cancelled' where id = o.id;
    return jsonb_build_object('stale', true, 'profile', private.profile_json(me));
  end if;

  -- 3) transfert atomique
  v_old_b := buyer.owned; v_old_s := seller.owned;
  buyer.abris  := buyer.abris - o.price;
  seller.abris := seller.abris + o.price;
  buyer.owned  := private.owned_add(buyer.owned, o.card_id, 1);
  seller.owned := private.owned_add(seller.owned, o.card_id, -1);
  buyer.obtained_at := private.obtained_stamp(buyer.obtained_at, v_old_b, buyer.owned);

  update public.profiles set abris = buyer.abris,  owned = buyer.owned,  obtained_at = buyer.obtained_at  where id = buyer.id;
  update public.profiles set abris = seller.abris, owned = seller.owned where id = seller.id;
  update public.player_listings set status = 'filled', filled_at = now(), filled_by = uid where id = o.id;

  if o.side = 'sell' then me := buyer; else me := seller; end if;
  return jsonb_build_object('profile', private.profile_json(me), 'price', o.price, 'side', o.side, 'card_id', o.card_id);
end;
$$;
revoke all on function public.accept_player_offer(uuid) from public, anon;
grant execute on function public.accept_player_offer(uuid) to authenticated;
