-- =====================================================================
-- Collecto : échanges v2 = 1 à 5 cartes par camp + Abri$ d'un seul côté
-- À exécuter APRÈS schema.sql, social.sql, admin.sql, achievements.sql et obtained_at.sql.
-- Script incrémental et relançable.
--
-- Note : trades.id reste un "bigint" (identité) et non un uuid : accept_trade /
-- decline_trade / cancel_trade gardent donc leur paramètre p_trade_id bigint.
-- Aucune donnée n'est convertie, l'application passe simplement l'id reçu de list_social().
-- =====================================================================

-- 1) Colonnes ---------------------------------------------------------
alter table public.trades add column if not exists offered_cards   text[] not null default '{}';
alter table public.trades add column if not exists requested_cards text[] not null default '{}';
alter table public.trades add column if not exists offered_abris   integer not null default 0;
alter table public.trades add column if not exists requested_abris integer not null default 0;

-- Anciennes propositions (1 carte contre 1 carte) -> tableaux
update public.trades
   set offered_cards   = array[offered_card_id],
       requested_cards = array[requested_card_id]
 where cardinality(offered_cards) = 0 and cardinality(requested_cards) = 0
   and offered_card_id is not null and requested_card_id is not null;

-- Les anciennes colonnes sont conservées (historique) mais ne sont plus obligatoires
alter table public.trades alter column offered_card_id   drop not null;
alter table public.trades alter column requested_card_id drop not null;

-- Anciennes règles "1 carte" : check offered <> requested et index d'unicité
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.trades'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%offered_card_id%requested_card_id%'
  loop
    execute format('alter table public.trades drop constraint %I', c.conname);
  end loop;
end $$;
drop index if exists public.trades_pending_unique_idx;

-- Nouvelles règles
alter table public.trades drop constraint if exists trades_v2_chk;
alter table public.trades add constraint trades_v2_chk check (
  cardinality(offered_cards) <= 5 and cardinality(requested_cards) <= 5
  and offered_abris >= 0 and requested_abris >= 0
  and not (offered_abris > 0 and requested_abris > 0)               -- argent d'un seul côté
  and cardinality(offered_cards)   + offered_abris   > 0             -- chaque camp donne quelque chose
  and cardinality(requested_cards) + requested_abris > 0
  and cardinality(offered_cards) + cardinality(requested_cards) >= 1
);

-- Pas deux fois exactement la même proposition en attente (les tableaux sont stockés triés)
create unique index if not exists trades_pending_unique_v2_idx
  on public.trades (sender_id, receiver_id, offered_cards, requested_cards, offered_abris, requested_abris)
  where status = 'pending';

-- 2) Outil : nombre d'exemplaires nécessaires par carte ------------------
-- Vrai si "owned" contient au moins les quantités demandées (doublons du tableau = exemplaires multiples).
create or replace function private.has_cards(owned jsonb, cards text[])
returns boolean
language sql
immutable
as $$
  select not exists (
    select 1
      from (select c, count(*)::integer as n from unnest(cards) c group by c) x
     where coalesce((owned ->> x.c)::integer, 0) < x.n
  );
$$;

-- Transfère les cartes d'un tableau (retire de "o", ajoute les mêmes à "o" selon delta_sign)
create or replace function private.owned_apply(o jsonb, cards text[], sign integer)
returns jsonb
language plpgsql
immutable
as $$
declare r record;
begin
  for r in select c, count(*)::integer as n from unnest(cards) c group by c loop
    o := private.owned_add(o, r.c, sign * r.n);
  end loop;
  return o;
end;
$$;
revoke all on function private.has_cards(jsonb, text[])        from public, anon, authenticated;
revoke all on function private.owned_apply(jsonb, text[], integer) from public, anon, authenticated;

-- 3) propose_trade ---------------------------------------------------------
drop function if exists public.propose_trade(text, text, text);
drop function if exists public.propose_trade(text, text[], text[], integer, integer);

create or replace function public.propose_trade(
  p_to_pseudo text,
  p_offered_cards text[],
  p_requested_cards text[],
  p_offered_abris integer default 0,
  p_requested_abris integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  mine public.profiles;
  theirs public.profiles;
  o text[];
  r text[];
  oa integer := coalesce(p_offered_abris, 0);
  ra integer := coalesce(p_requested_abris, 0);
  pending_count integer;
  new_id bigint;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  target := private.find_player(p_to_pseudo);
  if target is null then raise exception 'player_not_found'; end if;
  if target = uid then raise exception 'cannot_trade_with_self'; end if;
  if not private.are_friends(uid, target) then raise exception 'not_friends'; end if;

  if (select count(*) from unnest(coalesce(p_offered_cards, '{}'::text[])) x where x is null) > 0
     or (select count(*) from unnest(coalesce(p_requested_cards, '{}'::text[])) x where x is null) > 0 then
    raise exception 'unknown_card';
  end if;
  -- tableaux triés : deux propositions identiques sont reconnues comme telles
  select coalesce(array_agg(x order by x), '{}') into o from unnest(coalesce(p_offered_cards, '{}'::text[])) x;
  select coalesce(array_agg(x order by x), '{}') into r from unnest(coalesce(p_requested_cards, '{}'::text[])) x;

  if cardinality(o) > 5 or cardinality(r) > 5 then raise exception 'invalid_card_count'; end if;
  if oa < 0 or ra < 0 then raise exception 'invalid_abris'; end if;
  if oa > 0 and ra > 0 then raise exception 'abris_both_sides'; end if;
  if cardinality(o) + oa = 0 or cardinality(r) + ra = 0 or cardinality(o) + cardinality(r) = 0 then
    raise exception 'invalid_card_count';
  end if;
  if o && r then raise exception 'same_card'; end if;

  if (select count(distinct x) from unnest(o || r) x) <> (select count(*) from public.cards where id = any (o || r)) then
    raise exception 'unknown_card';
  end if;

  select * into mine   from public.profiles where id = uid;
  select * into theirs from public.profiles where id = target;
  if not private.has_cards(mine.owned, o)   then raise exception 'card_not_owned'; end if;
  if not private.has_cards(theirs.owned, r) then raise exception 'friend_lacks_card'; end if;
  if mine.abris   < oa then raise exception 'not_enough_abris'; end if;
  if theirs.abris < ra then raise exception 'friend_not_enough_abris'; end if;

  select count(*) into pending_count from public.trades where sender_id = uid and status = 'pending';
  if pending_count >= 20 then raise exception 'too_many_trades'; end if;

  insert into public.trades (sender_id, receiver_id, offered_cards, requested_cards, offered_abris, requested_abris)
  values (uid, target, o, r, oa, ra)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'trade_id', new_id);
exception
  when unique_violation then raise exception 'trade_already_proposed';
end;
$$;

-- 4) accept_trade ----------------------------------------------------------
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

  -- 1. verrou de la proposition
  select * into t from public.trades where id = p_trade_id for update;
  if not found or t.receiver_id <> uid then raise exception 'trade_not_found'; end if;
  if t.status <> 'pending' then raise exception 'trade_not_pending'; end if;
  if not private.are_friends(t.sender_id, t.receiver_id) then raise exception 'not_friends'; end if;

  -- 2. verrou des deux profils (FOR UPDATE dans private.regen), toujours dans l'ordre des id
  perform private.regen(least(t.sender_id, t.receiver_id));
  perform private.regen(greatest(t.sender_id, t.receiver_id));
  select * into s from public.profiles where id = t.sender_id;
  select * into r from public.profiles where id = t.receiver_id;

  -- 3. tout est revérifié sous verrou
  if not private.has_cards(s.owned, t.offered_cards)   then raise exception 'sender_lacks_card'; end if;
  if not private.has_cards(r.owned, t.requested_cards) then raise exception 'you_lack_card'; end if;
  if s.abris < t.offered_abris   then raise exception 'sender_lacks_abris'; end if;
  if r.abris < t.requested_abris then raise exception 'you_lack_abris'; end if;

  -- 4. transfert atomique cartes + Abri$
  s_new := private.owned_apply(private.owned_apply(s.owned, t.offered_cards, -1), t.requested_cards, 1);
  r_new := private.owned_apply(private.owned_apply(r.owned, t.requested_cards, -1), t.offered_cards, 1);
  s.obtained_at := private.obtained_stamp(s.obtained_at, s.owned, s_new);
  r.obtained_at := private.obtained_stamp(r.obtained_at, r.owned, r_new);
  s.owned := s_new;
  r.owned := r_new;
  s.abris := s.abris - t.offered_abris + t.requested_abris;
  r.abris := r.abris + t.offered_abris - t.requested_abris;

  update public.profiles set owned = s.owned, obtained_at = s.obtained_at, abris = s.abris where id = s.id;
  update public.profiles set owned = r.owned, obtained_at = r.obtained_at, abris = r.abris where id = r.id;
  update public.trades set status = 'accepted' where id = t.id;

  return private.profile_json(r);
end;
$$;

-- 5) list_social -----------------------------------------------------------
-- Cartes d'un lot : [{id, rarete}, ...] (doublons conservés, ordre du tableau)
create or replace function private.cards_json(cards text[])
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.c, 'rarete', (select rarete from public.cards where id = x.c))
                            order by x.ord), '[]'::jsonb)
    from unnest(cards) with ordinality as x(c, ord);
$$;
revoke all on function private.cards_json(text[]) from public, anon, authenticated;

create or replace function public.list_social()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  return jsonb_build_object(
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object('pseudo', p.pseudo) order by lower(p.pseudo))
        from public.friendships f
        join public.profiles p on p.id = case when f.user_id = uid then f.friend_id else f.user_id end
       where f.status = 'accepted' and uid in (f.user_id, f.friend_id)
    ), '[]'::jsonb),

    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('pseudo', p.pseudo) order by f.created_at)
        from public.friendships f
        join public.profiles p on p.id = f.user_id
       where f.status = 'pending' and f.friend_id = uid
    ), '[]'::jsonb),

    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('pseudo', p.pseudo) order by f.created_at)
        from public.friendships f
        join public.profiles p on p.id = f.friend_id
       where f.status = 'pending' and f.user_id = uid
    ), '[]'::jsonb),

    'trades_in', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id,
               'from', sp.pseudo,
               'offered_cards', private.cards_json(t.offered_cards),
               'requested_cards', private.cards_json(t.requested_cards),
               'offered_abris', t.offered_abris,
               'requested_abris', t.requested_abris,
               'created_at_ms', (extract(epoch from t.created_at) * 1000)::bigint,
               -- recalculé en direct : amis, cartes et Abri$ des deux côtés
               'can_accept', private.are_friends(t.sender_id, t.receiver_id)
                             and private.has_cards(sp.owned, t.offered_cards)
                             and private.has_cards(mp.owned, t.requested_cards)
                             and sp.abris >= t.offered_abris
                             and mp.abris >= t.requested_abris
             ) order by t.created_at desc)
        from public.trades t
        join public.profiles sp on sp.id = t.sender_id
        join public.profiles mp on mp.id = t.receiver_id
       where t.receiver_id = uid and t.status = 'pending'
    ), '[]'::jsonb),

    'trades_out', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id,
               'to', rp.pseudo,
               'offered_cards', private.cards_json(t.offered_cards),
               'requested_cards', private.cards_json(t.requested_cards),
               'offered_abris', t.offered_abris,
               'requested_abris', t.requested_abris,
               'created_at_ms', (extract(epoch from t.created_at) * 1000)::bigint
             ) order by t.created_at desc)
        from public.trades t
        join public.profiles rp on rp.id = t.receiver_id
       where t.sender_id = uid and t.status = 'pending'
    ), '[]'::jsonb),

    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', h.id,
               'status', h.status,
               'from', h.from_pseudo,
               'to', h.to_pseudo,
               'i_am_sender', h.sender_id = uid,
               'offered_cards', private.cards_json(h.offered_cards),
               'requested_cards', private.cards_json(h.requested_cards),
               'offered_abris', h.offered_abris,
               'requested_abris', h.requested_abris
             ) order by h.created_at desc)
        from (
          select t.*, sp.pseudo as from_pseudo, rp.pseudo as to_pseudo
            from public.trades t
            join public.profiles sp on sp.id = t.sender_id
            join public.profiles rp on rp.id = t.receiver_id
           where t.status <> 'pending' and uid in (t.sender_id, t.receiver_id)
           order by t.created_at desc
           limit 10
        ) h
    ), '[]'::jsonb)
  );
end;
$$;

-- 6) Droits -----------------------------------------------------------------
revoke all on function public.propose_trade(text, text[], text[], integer, integer) from public, anon;
revoke all on function public.accept_trade(bigint)                                  from public, anon;
revoke all on function public.list_social()                                         from public, anon;
grant execute on function public.propose_trade(text, text[], text[], integer, integer) to authenticated;
grant execute on function public.accept_trade(bigint)                                  to authenticated;
grant execute on function public.list_social()                                         to authenticated;
