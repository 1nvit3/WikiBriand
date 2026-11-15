-- =====================================================================
-- Collecto : schéma Supabase
--
-- À exécuter UNE fois dans Supabase > SQL Editor, puis exécuter seed_cards.sql.
-- Ce script peut être relancé sans danger (il met à jour sans rien effacer).
--
-- Principe de sécurité : les joueurs ne peuvent PAS écrire dans les tables.
-- Toutes les actions (tirage d'un booster, vente, recharge des boosters) passent
-- par des fonctions SQL qui s'exécutent côté serveur, avec l'horloge du serveur
-- et le hasard du serveur. Impossible de se donner des Abri$ ou des cartes depuis
-- la console du navigateur.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Raretés : probabilité (en %) et prix de revente.
-- Les clés doivent correspondre à app.js (commun, peu-commun, rare, ...).
-- ---------------------------------------------------------------------
create table if not exists public.rarities (
  rarete text primary key,
  weight numeric not null check (weight > 0),
  sell   integer not null check (sell >= 0)
);

insert into public.rarities (rarete, weight, sell) values
  ('commun',      60,   5),
  ('peu-commun',  25,   10),
  ('rare',        10,   25),
  ('epique',      4,    75),
  ('legendaire',  0.9,  200),
  ('divin',       0.1,  500)
on conflict (rarete) do update set weight = excluded.weight, sell = excluded.sell;

-- ---------------------------------------------------------------------
-- Cartes : le serveur n'a besoin que de l'id et de la rareté pour tirer.
-- (titre, image, stats... restent dans cards.json côté application.)
-- Remplie par seed_cards.sql, générée depuis cards.json.
-- ---------------------------------------------------------------------
create table if not exists public.cards (
  id     text primary key,
  rarete text not null references public.rarities (rarete)
);

-- ---------------------------------------------------------------------
-- Profils : une ligne par joueur, liée au compte (auth.users).
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  pseudo     text not null check (pseudo ~ '^[A-Za-z0-9_-]{3,16}$'),
  abris      integer not null default 300 check (abris >= 0),
  boosters   integer not null default 3 check (boosters between 0 and 5),
  last_tick  timestamptz not null default now(),   -- départ du compteur d'1 heure
  owned      jsonb not null default '{}'::jsonb,   -- { "id-de-carte": quantité }
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_pseudo_lower_idx on public.profiles (lower(pseudo));

-- ---------------------------------------------------------------------
-- Accès aux tables (RLS)
-- ---------------------------------------------------------------------
alter table public.rarities enable row level security;
alter table public.cards    enable row level security;
alter table public.profiles enable row level security;

revoke all on public.rarities, public.cards, public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- Un joueur peut seulement LIRE sa propre ligne. Aucune règle d'écriture : volontaire.
drop policy if exists "lecture de son propre profil" on public.profiles;
create policy "lecture de son propre profil"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Création automatique du profil à l'inscription (pseudo envoyé par l'app)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, pseudo)
  values (new.id, new.raw_user_meta_data ->> 'pseudo');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Fonctions internes (non accessibles depuis l'application)
-- ---------------------------------------------------------------------

-- Recharge des boosters : 1 par heure, 5 maximum, calculé avec l'heure du serveur.
-- Même logique que le miroir affiché dans app.js. Verrouille la ligne du joueur.
create or replace function private.regen(p_uid uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public, private
as $$
declare
  p public.profiles;
  gained integer;
  max_boosters constant integer := 5;
  every constant interval := interval '1 hour';
begin
  select * into p from public.profiles where id = p_uid for update;
  if not found then
    raise exception 'profile_not_found';
  end if;

  if p.boosters >= max_boosters then
    return p;                                   -- stock plein : rien à recharger
  end if;

  if now() < p.last_tick then
    p.last_tick := now();                       -- sécurité si l'horodatage est dans le futur
  else
    gained := floor(extract(epoch from (now() - p.last_tick)) / extract(epoch from every))::integer;
    if gained > 0 then
      p.boosters  := least(max_boosters, p.boosters + gained);
      p.last_tick := p.last_tick + gained * every;
    end if;
  end if;

  update public.profiles
     set boosters = p.boosters, last_tick = p.last_tick
   where id = p_uid;
  return p;
end;
$$;

-- Ce que l'application reçoit (heures en millisecondes pour éviter tout souci de format).
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
    'last_tick_ms',  (extract(epoch from p.last_tick) * 1000)::bigint,
    'server_now_ms', (extract(epoch from now()) * 1000)::bigint
  );
$$;

-- ---------------------------------------------------------------------
-- Fonctions appelées par l'application (rpc)
-- ---------------------------------------------------------------------

-- Lit le profil (après recharge des boosters).
create or replace function public.get_profile()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  before_boosters integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select boosters into before_boosters from public.profiles where id = uid;
  p := private.regen(uid);
  return private.profile_json(p)
         || jsonb_build_object('gained', p.boosters - coalesce(before_boosters, p.boosters));
end;
$$;

-- Ouvre un booster : consomme 1 booster, tire 5 cartes avec les probabilités de `rarities`.
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
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(
      jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0)
    );
  end loop;

  update public.profiles
     set boosters = p.boosters, last_tick = p.last_tick, owned = p.owned
   where id = uid;

  return private.profile_json(p) || jsonb_build_object('cards', v_cards);
end;
$$;

-- Revend des exemplaires d'une carte au prix de sa rareté.
create or replace function public.sell_cards(p_card_id text, p_qty integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  have integer;
  price integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'invalid_quantity'; end if;

  p := private.regen(uid);

  have := coalesce((p.owned ->> p_card_id)::integer, 0);
  if have < p_qty then raise exception 'not_enough_cards'; end if;

  select r.sell into price
    from public.cards c
    join public.rarities r on r.rarete = c.rarete
   where c.id = p_card_id;
  if price is null then raise exception 'unknown_card'; end if;

  if have - p_qty > 0 then
    p.owned := jsonb_set(p.owned, array[p_card_id], to_jsonb(have - p_qty));
  else
    p.owned := p.owned - p_card_id;
  end if;
  p.abris := p.abris + price * p_qty;

  update public.profiles set abris = p.abris, owned = p.owned where id = uid;

  return private.profile_json(p) || jsonb_build_object('gain', price * p_qty);
end;
$$;

-- Remet la collection à zéro (les Abri$ et les boosters sont conservés).
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
  update public.profiles set owned = p.owned where id = uid;
  return private.profile_json(p);
end;
$$;

-- ---------------------------------------------------------------------
-- Droits d'exécution : seuls les joueurs connectés appellent les fonctions publiques
-- ---------------------------------------------------------------------
revoke all on function private.regen(uuid)              from public, anon, authenticated;
revoke all on function private.profile_json(public.profiles) from public, anon, authenticated;

revoke all on function public.get_profile()             from public, anon;
revoke all on function public.open_booster()            from public, anon;
revoke all on function public.sell_cards(text, integer) from public, anon;
revoke all on function public.reset_collection()        from public, anon;

grant execute on function public.get_profile()             to authenticated;
grant execute on function public.open_booster()            to authenticated;
grant execute on function public.sell_cards(text, integer) to authenticated;
grant execute on function public.reset_collection()        to authenticated;
