-- =====================================================================
-- Collecto : boutique de boosters (achat en Abri$, meilleures probabilités)
-- À exécuter APRÈS schema.sql, social.sql, admin.sql, achievements.sql, obtained_at.sql
-- (et trades_v2.sql). Script relançable. Les réglages de l'application (vibrations,
-- animations) sont enregistrés dans le navigateur : rien à créer ici pour eux.
--
-- Paliers (prix et multiplicateurs de poids, appliqués au poids de public.rarities) :
--   standard  150 Abri$ : poids classiques
--   super     400 Abri$ : rare x2.5, épique x3, légendaire x3, divin x2
--   ultra    1000 Abri$ : rare x3,   épique x6, légendaire x8, divin x5
-- Les prix affichés dans app.js (SHOP) doivent correspondre à ceux-ci.
-- =====================================================================

create or replace function private.shop_tier(p_tier text, out price integer, out mult jsonb)
language plpgsql
immutable
as $$
begin
  case p_tier
    when 'standard' then price := 150;  mult := '{}'::jsonb;
    when 'super'    then price := 400;  mult := '{"rare":2.5,"epique":3,"legendaire":3,"divin":2}'::jsonb;
    when 'ultra'    then price := 1000; mult := '{"rare":3,"epique":6,"legendaire":8,"divin":5}'::jsonb;
    else raise exception 'unknown_tier';
  end case;
end;
$$;
revoke all on function private.shop_tier(text, out integer, out jsonb) from public, anon, authenticated;

create or replace function public.buy_booster(p_tier text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  t record;
  booster_size constant integer := 5;
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

  select * into t from private.shop_tier(p_tier);

  -- verrouille le profil (FOR UPDATE dans private.regen) puis vérifie le solde
  p := private.regen(uid);
  if p.abris < t.price then raise exception 'not_enough_abris'; end if;

  -- poids effectifs : poids de la table x multiplicateur du palier (raretés qui ont des cartes)
  select coalesce(sum(r.weight * coalesce((t.mult ->> r.rarete)::numeric, 1)), 0) into v_total
    from public.rarities r
   where exists (select 1 from public.cards c where c.rarete = r.rarete);
  if v_total = 0 then raise exception 'no_cards'; end if;

  p.abris := p.abris - t.price;

  for i in 1..booster_size loop
    v_roll := random() * v_total;
    v_acc  := 0;
    v_rar  := null;
    for rec in
      select r.rarete, r.weight * coalesce((t.mult ->> r.rarete)::numeric, 1) as w
        from public.rarities r
       where exists (select 1 from public.cards c where c.rarete = r.rarete)
       order by w desc, r.rarete
    loop
      v_acc := v_acc + rec.w;
      v_rar := rec.rarete;
      exit when v_roll < v_acc;
    end loop;

    select c.id into v_card from public.cards c where c.rarete = v_rar order by random() limit 1;

    v_prev := coalesce((p.owned ->> v_card)::integer, 0);
    if v_prev = 0 then
      p.obtained_at := jsonb_set(p.obtained_at, array[v_card], to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), true);
    end if;
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(
      jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0));
  end loop;

  update public.profiles
     set abris = p.abris, owned = p.owned, obtained_at = p.obtained_at
   where id = uid;

  return jsonb_build_object('profile', private.profile_json(p), 'cards', v_cards);
end;
$$;

revoke all on function public.buy_booster(text) from public, anon;
grant execute on function public.buy_booster(text) to authenticated;
