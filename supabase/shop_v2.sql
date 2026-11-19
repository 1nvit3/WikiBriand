-- =====================================================================
-- WikiBrand v1.7 : boosters à rareté garantie
-- À exécuter APRÈS shop_and_settings.sql (qui crée profiles.shop_bought). Relançable.
--
--   standard            150 Abri$ : 5 cartes, poids classiques
--   super               400 Abri$ : 5 cartes, rare x2.5, épique x3, légendaire x3, divin x2
--   ultra              1000 Abri$ : 5 cartes, rare x3, épique x6, légendaire x8, divin x5
--   garanti_epique     2000 Abri$ : 3 cartes dont >= 1 Épique (ou mieux) garantie
--   garanti_legendaire 5000 Abri$ : 3 cartes dont >= 1 Légendaire (ou mieux) garantie
-- (les 2 autres cartes d'un paquet garanti sont tirées avec les poids de « ultra »)
-- Si aucune carte n'existe à la rareté demandée ou au-dessus, la carte garantie
-- est tirée dans la meilleure rareté disponible. Les prix de app.js (SHOP) doivent correspondre.
-- =====================================================================

-- ordre des raretés (0 = commune ... 5 = divine)
create or replace function private.rarity_rank(r text)
returns integer language sql immutable as $$
  select coalesce(array_position(array['commun','peu-commun','rare','epique','legendaire','divin'], r), 0) - 1
$$;
revoke all on function private.rarity_rank(text) from public, anon, authenticated;

drop function if exists private.shop_tier(text);
create or replace function private.shop_tier(p_tier text, out price integer, out mult jsonb, out card_count integer, out min_rarity text)
language plpgsql immutable as $$
begin
  card_count := 5; min_rarity := null;
  case p_tier
    when 'standard' then price := 150;  mult := '{}'::jsonb;
    when 'super'    then price := 400;  mult := '{"rare":2.5,"epique":3,"legendaire":3,"divin":2}'::jsonb;
    when 'ultra'    then price := 1000; mult := '{"rare":3,"epique":6,"legendaire":8,"divin":5}'::jsonb;
    when 'garanti_epique' then
      price := 2000; card_count := 3; min_rarity := 'epique';
      mult := '{"rare":3,"epique":6,"legendaire":8,"divin":5}'::jsonb;
    when 'garanti_legendaire' then
      price := 5000; card_count := 3; min_rarity := 'legendaire';
      mult := '{"rare":3,"epique":6,"legendaire":8,"divin":5}'::jsonb;
    else raise exception 'unknown_tier';
  end case;
end;
$$;
revoke all on function private.shop_tier(text) from public, anon, authenticated;

-- tire une rareté (poids x multiplicateur). p_min : rareté minimale (null = aucune).
create or replace function private.draw_rarity(p_mult jsonb, p_min text)
returns text language plpgsql volatile as $$
declare
  v_min integer := case when p_min is null then -1 else private.rarity_rank(p_min) end;
  v_total numeric; v_roll numeric; v_acc numeric := 0; v_rar text; rec record;
begin
  select coalesce(sum(r.weight * coalesce((p_mult ->> r.rarete)::numeric, 1)), 0) into v_total
    from public.rarities r
   where private.rarity_rank(r.rarete) >= v_min and exists (select 1 from public.cards c where c.rarete = r.rarete);
  if v_total = 0 then
    -- repli : meilleure rareté qui possède des cartes
    select r.rarete into v_rar from public.rarities r
     where exists (select 1 from public.cards c where c.rarete = r.rarete)
     order by private.rarity_rank(r.rarete) desc limit 1;
    return v_rar;
  end if;
  v_roll := random() * v_total;
  for rec in
    select r.rarete, r.weight * coalesce((p_mult ->> r.rarete)::numeric, 1) as w
      from public.rarities r
     where private.rarity_rank(r.rarete) >= v_min and exists (select 1 from public.cards c where c.rarete = r.rarete)
     order by w desc, r.rarete
  loop
    v_acc := v_acc + rec.w; v_rar := rec.rarete;
    exit when v_roll < v_acc;
  end loop;
  return v_rar;
end;
$$;
revoke all on function private.draw_rarity(jsonb, text) from public, anon, authenticated;

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
  v_rar text; v_card text; v_prev integer;
  v_cards jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into t from private.shop_tier(p_tier);

  -- verrouille le profil (FOR UPDATE dans private.regen) puis vérifie le solde
  p := private.regen(uid);
  if p.abris < t.price then raise exception 'not_enough_abris'; end if;
  if not exists (select 1 from public.cards) then raise exception 'no_cards'; end if;
  p.abris := p.abris - t.price;

  for i in 1..t.card_count loop
    -- la 1re carte d'un paquet garanti est tirée dans « rareté minimale ou mieux »
    v_rar := private.draw_rarity(t.mult, case when i = 1 then t.min_rarity else null end);
    select c.id into v_card from public.cards c where c.rarete = v_rar order by random() limit 1;
    v_prev := coalesce((p.owned ->> v_card)::integer, 0);
    if v_prev = 0 then
      p.obtained_at := jsonb_set(p.obtained_at, array[v_card], to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), true);
    end if;
    p.owned := jsonb_set(p.owned, array[v_card], to_jsonb(v_prev + 1), true);
    v_cards := v_cards || jsonb_build_array(jsonb_build_object('id', v_card, 'rarete', v_rar, 'is_new', v_prev = 0));
  end loop;

  update public.profiles
     set abris = p.abris, owned = p.owned, obtained_at = p.obtained_at, shop_bought = shop_bought + 1
   where id = uid;

  return jsonb_build_object('profile', private.profile_json(p), 'cards', v_cards);
end;
$$;
revoke all on function public.buy_booster(text) from public, anon;
grant execute on function public.buy_booster(text) to authenticated;
