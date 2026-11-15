-- =====================================================================
-- Collecto : amis, visite de profil et échanges de cartes
--
-- À exécuter dans Supabase > SQL Editor APRÈS schema.sql et seed_cards.sql.
-- Peut être relancé sans danger (aucune donnée n'est effacée).
--
-- Même principe de sécurité que le reste : les joueurs ne peuvent rien écrire
-- directement dans ces tables. Tout passe par les fonctions ci-dessous, qui vérifient
-- les droits côté serveur. Un échange déplace les cartes des DEUX collections dans une
-- seule transaction : il réussit en entier ou pas du tout.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Amitiés
--   user_id   : le joueur qui a envoyé la demande
--   friend_id : le joueur qui la reçoit
--   status    : 'pending' (en attente) ou 'accepted' (amis)
-- Refuser une demande supprime la ligne.
-- ---------------------------------------------------------------------
create table if not exists public.friendships (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  friend_id  uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (user_id <> friend_id)
);

-- Une seule ligne par paire de joueurs, quel que soit le sens de la demande
create unique index if not exists friendships_pair_idx
  on public.friendships (least(user_id, friend_id), greatest(user_id, friend_id));
create index if not exists friendships_friend_idx on public.friendships (friend_id);

-- ---------------------------------------------------------------------
-- Échanges
--   sender_id         : celui qui propose
--   receiver_id       : celui qui reçoit la proposition
--   offered_card_id   : la carte que l'expéditeur donne
--   requested_card_id : la carte que l'expéditeur veut en retour
--   status            : 'pending', 'accepted' ou 'declined'
-- (Annuler sa propre proposition supprime la ligne.)
-- ---------------------------------------------------------------------
create table if not exists public.trades (
  id                bigint generated always as identity primary key,
  sender_id         uuid not null references public.profiles (id) on delete cascade,
  receiver_id       uuid not null references public.profiles (id) on delete cascade,
  offered_card_id   text not null,
  requested_card_id text not null,
  status            text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at        timestamptz not null default now(),
  check (sender_id <> receiver_id),
  check (offered_card_id <> requested_card_id)
);

-- Pas deux fois la même proposition en attente
create unique index if not exists trades_pending_unique_idx
  on public.trades (sender_id, receiver_id, offered_card_id, requested_card_id)
  where status = 'pending';
create index if not exists trades_receiver_idx on public.trades (receiver_id, status);
create index if not exists trades_sender_idx   on public.trades (sender_id, status);

-- ---------------------------------------------------------------------
-- Accès aux tables : fermé aux joueurs (tout passe par les fonctions)
-- ---------------------------------------------------------------------
alter table public.friendships enable row level security;
alter table public.trades      enable row level security;
revoke all on public.friendships, public.trades from anon, authenticated;

-- ---------------------------------------------------------------------
-- Fonctions internes
-- ---------------------------------------------------------------------
create or replace function private.find_player(p_pseudo text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where lower(pseudo) = lower(coalesce(p_pseudo, ''));
$$;

create or replace function private.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and ((f.user_id = a and f.friend_id = b) or (f.user_id = b and f.friend_id = a))
  );
$$;

-- Ajoute (ou retire, si delta < 0) des exemplaires dans une collection ; la clé disparaît à 0.
create or replace function private.owned_add(o jsonb, card text, delta integer)
returns jsonb
language plpgsql
immutable
as $$
declare
  n integer := coalesce((o ->> card)::integer, 0) + delta;
begin
  if n <= 0 then return o - card; end if;
  return jsonb_set(o, array[card], to_jsonb(n), true);
end;
$$;

revoke all on function private.find_player(text)                   from public, anon, authenticated;
revoke all on function private.are_friends(uuid, uuid)             from public, anon, authenticated;
revoke all on function private.owned_add(jsonb, text, integer)     from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Amis
-- ---------------------------------------------------------------------

-- Recherche par pseudo (2 caractères minimum, 10 résultats). Ne renvoie que le pseudo
-- et le lien avec toi : 'none', 'sent', 'received' ou 'friend'.
create or replace function public.search_players(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  q text := trim(coalesce(p_query, ''));
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if length(q) < 2 then raise exception 'query_too_short'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('pseudo', s.pseudo, 'relation', s.relation) order by s.pos, lower(s.pseudo))
      from (
        select p.pseudo,
               strpos(lower(p.pseudo), lower(q)) as pos,
               case
                 when f.id is null then 'none'
                 when f.status = 'accepted' then 'friend'
                 when f.user_id = uid then 'sent'
                 else 'received'
               end as relation
          from public.profiles p
          left join public.friendships f
            on (f.user_id = uid and f.friend_id = p.id) or (f.friend_id = uid and f.user_id = p.id)
         where p.id <> uid and strpos(lower(p.pseudo), lower(q)) > 0
         order by strpos(lower(p.pseudo), lower(q)), lower(p.pseudo)
         limit 10
      ) s
  ), '[]'::jsonb);
end;
$$;

-- Envoie une demande d'ami. Si l'autre joueur t'en avait déjà envoyé une, vous devenez amis.
create or replace function public.send_friend_request(p_pseudo text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  f public.friendships;
  pending_count integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  target := private.find_player(p_pseudo);
  if target is null then raise exception 'player_not_found'; end if;
  if target = uid then raise exception 'cannot_add_self'; end if;

  select * into f from public.friendships
   where (user_id = uid and friend_id = target) or (user_id = target and friend_id = uid)
   for update;
  if found then
    if f.status = 'accepted' then raise exception 'already_friends'; end if;
    if f.user_id = uid then raise exception 'request_already_sent'; end if;
    update public.friendships set status = 'accepted' where id = f.id;
    return jsonb_build_object('result', 'accepted');
  end if;

  select count(*) into pending_count from public.friendships where user_id = uid and status = 'pending';
  if pending_count >= 30 then raise exception 'too_many_requests'; end if;

  insert into public.friendships (user_id, friend_id) values (uid, target);
  return jsonb_build_object('result', 'sent');
exception
  when unique_violation then raise exception 'request_already_sent';
end;
$$;

-- Accepte (p_accept = true) ou refuse (false) une demande reçue.
create or replace function public.respond_friend_request(p_pseudo text, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  requester uuid;
  n integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  requester := private.find_player(p_pseudo);
  if requester is null then raise exception 'request_not_found'; end if;

  if p_accept then
    update public.friendships set status = 'accepted'
     where user_id = requester and friend_id = uid and status = 'pending';
  else
    delete from public.friendships
     where user_id = requester and friend_id = uid and status = 'pending';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'request_not_found'; end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Profil d'un AMI, en lecture seule : Abri$, collection et avancement.
create or replace function public.get_friend_profile(p_pseudo text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  p public.profiles;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  target := private.find_player(p_pseudo);
  if target is null or not private.are_friends(uid, target) then
    raise exception 'not_friends';
  end if;

  select * into p from public.profiles where id = target;
  return jsonb_build_object(
    'pseudo', p.pseudo,
    'abris', p.abris,
    'owned', p.owned,
    'unique_owned', (select count(*) from jsonb_object_keys(p.owned) as k join public.cards c on c.id = k),
    'total_cards', (select count(*) from public.cards)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Échanges
-- ---------------------------------------------------------------------

-- Propose à un ami : "je te donne offered contre ta carte requested".
create or replace function public.propose_trade(p_to_pseudo text, p_offered text, p_requested text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  mine jsonb;
  theirs jsonb;
  pending_count integer;
  new_id bigint;
begin
  if uid is null then raise exception 'not_authenticated'; end if;

  target := private.find_player(p_to_pseudo);
  if target is null then raise exception 'player_not_found'; end if;
  if target = uid then raise exception 'cannot_trade_with_self'; end if;
  if not private.are_friends(uid, target) then raise exception 'not_friends'; end if;
  if p_offered is null or p_requested is null or p_offered = p_requested then raise exception 'same_card'; end if;

  if (select count(*) from public.cards where id in (p_offered, p_requested)) <> 2 then
    raise exception 'unknown_card';
  end if;

  select owned into mine   from public.profiles where id = uid;
  select owned into theirs from public.profiles where id = target;
  if coalesce((mine ->> p_offered)::integer, 0) < 1 then raise exception 'card_not_owned'; end if;
  if coalesce((theirs ->> p_requested)::integer, 0) < 1 then raise exception 'friend_lacks_card'; end if;

  select count(*) into pending_count from public.trades where sender_id = uid and status = 'pending';
  if pending_count >= 20 then raise exception 'too_many_trades'; end if;

  insert into public.trades (sender_id, receiver_id, offered_card_id, requested_card_id)
  values (uid, target, p_offered, p_requested)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'trade_id', new_id);
exception
  when unique_violation then raise exception 'trade_already_proposed';
end;
$$;

-- Accepte un échange reçu : vérifie que les deux joueurs ont encore leur carte,
-- puis déplace les deux cartes. Renvoie TON profil à jour.
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

  s.owned := private.owned_add(private.owned_add(s.owned, t.offered_card_id, -1), t.requested_card_id, 1);
  r.owned := private.owned_add(private.owned_add(r.owned, t.requested_card_id, -1), t.offered_card_id, 1);

  update public.profiles set owned = s.owned where id = s.id;
  update public.profiles set owned = r.owned where id = r.id;
  update public.trades set status = 'accepted' where id = t.id;

  return private.profile_json(r);
end;
$$;

-- Refuse un échange reçu.
create or replace function public.decline_trade(p_trade_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  update public.trades set status = 'declined'
   where id = p_trade_id and receiver_id = uid and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'trade_not_found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Annule une proposition que tu as envoyée (et qui n'a pas encore reçu de réponse).
create or replace function public.cancel_trade(p_trade_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  delete from public.trades where id = p_trade_id and sender_id = uid and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'trade_not_found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Tout l'espace social en un seul appel : amis, demandes, échanges, historique.
-- ---------------------------------------------------------------------
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
               'offered', t.offered_card_id,
               'offered_rarete', (select c.rarete from public.cards c where c.id = t.offered_card_id),
               'requested', t.requested_card_id,
               'requested_rarete', (select c.rarete from public.cards c where c.id = t.requested_card_id),
               'created_at_ms', (extract(epoch from t.created_at) * 1000)::bigint,
               'can_accept', private.are_friends(t.sender_id, t.receiver_id)
                             and coalesce((sp.owned ->> t.offered_card_id)::integer, 0) >= 1
                             and coalesce((mp.owned ->> t.requested_card_id)::integer, 0) >= 1
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
               'offered', t.offered_card_id,
               'offered_rarete', (select c.rarete from public.cards c where c.id = t.offered_card_id),
               'requested', t.requested_card_id,
               'requested_rarete', (select c.rarete from public.cards c where c.id = t.requested_card_id),
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
               'offered', h.offered_card_id,
               'requested', h.requested_card_id
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

-- ---------------------------------------------------------------------
-- Droits d'exécution : joueurs connectés uniquement
-- ---------------------------------------------------------------------
revoke all on function public.search_players(text)                       from public, anon;
revoke all on function public.send_friend_request(text)                  from public, anon;
revoke all on function public.respond_friend_request(text, boolean)      from public, anon;
revoke all on function public.get_friend_profile(text)                   from public, anon;
revoke all on function public.propose_trade(text, text, text)            from public, anon;
revoke all on function public.accept_trade(bigint)                       from public, anon;
revoke all on function public.decline_trade(bigint)                      from public, anon;
revoke all on function public.cancel_trade(bigint)                       from public, anon;
revoke all on function public.list_social()                              from public, anon;

grant execute on function public.search_players(text)                    to authenticated;
grant execute on function public.send_friend_request(text)               to authenticated;
grant execute on function public.respond_friend_request(text, boolean)   to authenticated;
grant execute on function public.get_friend_profile(text)                to authenticated;
grant execute on function public.propose_trade(text, text, text)         to authenticated;
grant execute on function public.accept_trade(bigint)                    to authenticated;
grant execute on function public.decline_trade(bigint)                   to authenticated;
grant execute on function public.cancel_trade(bigint)                    to authenticated;
grant execute on function public.list_social()                           to authenticated;
