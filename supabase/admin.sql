-- =====================================================================
-- Collecto : mode Admin / Testeur  (à exécuter APRÈS schema.sql)
-- ⚠️ Remplace 'ton_pseudo' (en minuscules) à 1 seul endroit : private.is_admin().
-- Aucune table n'est modifiée ; open_booster / get_profile / sell_cards restent intacts.
-- =====================================================================

-- Seule source de vérité des comptes admin (insensible à la casse).
create or replace function private.is_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = p_uid and lower(pseudo) in ('ton_pseudo')
  );
$$;

-- Recharge instantanée : stock plein, +1000 Abri$, compteur horaire remis à zéro.
create or replace function public.admin_refill()
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not private.is_admin(uid) then raise exception 'unauthorized'; end if;

  update public.profiles
     set boosters  = 5,
         abris     = abris + 1000,
         last_tick = clock_timestamp()
   where id = uid;

  return public.get_profile();
end;
$$;

-- Booster de test : ne consomme PAS de booster.
--   p_force_rarity : si renseigné, les 5 cartes sont de cette rareté (ex. 'divin').
--   p_luck         : multiplie le poids de toutes les raretés sauf 'commun' (1 = normal, max 1000).
-- L'override n'existe que dans cet appel : la table rarities n'est ni lue en écriture ni modifiée.
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
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(
      jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0));
  end loop;

  update public.profiles set owned = p.owned where id = uid;

  return private.profile_json(p) || jsonb_build_object('cards', v_cards);
end;
$$;

revoke all on function private.is_admin(uuid)                    from public, anon, authenticated;
revoke all on function public.admin_refill()                     from public, anon;
revoke all on function public.admin_open_booster(text, numeric)  from public, anon;
grant execute on function public.admin_refill()                     to authenticated;
grant execute on function public.admin_open_booster(text, numeric)  to authenticated;
