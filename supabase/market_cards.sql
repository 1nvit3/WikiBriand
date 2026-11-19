-- =====================================================================
-- WikiBrand v1.7 : achat direct de cartes à prix dynamique
-- À exécuter APRÈS shop_v2.sql. Ordre complet : ... shop_and_settings.sql, achievements_v2.sql, shop_v2.sql, market_cards.sql.
--
-- prix = base(rareté) x (1 + 1.5 x (1 - détenteurs / joueurs)), arrondi à la dizaine supérieure
--   base : commun 80, peu-commun 180, rare 450, épique 1200, légendaire 3500, divin 9000
--   multiplicateur de x1.0 (tout le monde la possède) à x2.5 (personne ne la possède)
-- Les prix affichés par l'application viennent de get_card_market() ; le prix payé est
-- toujours recalculé par le serveur dans buy_card().
-- =====================================================================

create or replace function private.card_base_price(r text)
returns integer language sql immutable as $$
  select case r when 'commun' then 80 when 'peu-commun' then 180 when 'rare' then 450
                when 'epique' then 1200 when 'legendaire' then 3500 when 'divin' then 9000 else 80 end
$$;
revoke all on function private.card_base_price(text) from public, anon, authenticated;

create or replace function private.card_price(r text, owners bigint, total bigint)
returns integer language sql immutable as $$
  -- calcul exact en entiers : base x (1 + 1.5 x (total - owners) / total), arrondi à la dizaine supérieure
  select (((private.card_base_price(r)::bigint * (5 * greatest(total, 1) - 3 * least(greatest(owners, 0), greatest(total, 1)))
            + 20 * greatest(total, 1) - 1) / (20 * greatest(total, 1))) * 10)::integer
$$;
revoke all on function private.card_price(text, bigint, bigint) from public, anon, authenticated;

create or replace function public.get_card_market()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  v_total bigint;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select greatest(count(*), 1) into v_total from public.profiles;
  return jsonb_build_object(
    'total_players', v_total,
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'rarete', c.rarete,
               'owners_count', coalesce(o.n, 0),
               'price', private.card_price(c.rarete, coalesce(o.n, 0), v_total))
             order by private.rarity_rank(c.rarete), c.id)
        from public.cards c
        left join (select e.key as id, count(*) as n
                     from public.profiles pr, jsonb_each_text(pr.owned) e
                    where e.value ~ '^[0-9]+$' and e.value::integer > 0
                    group by e.key) o on o.id = c.id
    ), '[]'::jsonb));
end;
$$;
revoke all on function public.get_card_market() from public, anon;
grant execute on function public.get_card_market() to authenticated;

create or replace function public.buy_card(p_card_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  v_rar text; v_total bigint; v_owners bigint; v_price integer; v_prev integer;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select rarete into v_rar from public.cards where id = p_card_id;
  if v_rar is null then raise exception 'unknown_card'; end if;

  p := private.regen(uid);                                  -- verrouille le profil (FOR UPDATE)
  select greatest(count(*), 1) into v_total from public.profiles;
  select count(*) into v_owners from public.profiles pr
   where coalesce((pr.owned ->> p_card_id)::integer, 0) > 0;
  v_price := private.card_price(v_rar, v_owners, v_total);

  if p.abris < v_price then raise exception 'not_enough_abris'; end if;
  p.abris := p.abris - v_price;
  v_prev := coalesce((p.owned ->> p_card_id)::integer, 0);
  if v_prev = 0 then
    p.obtained_at := jsonb_set(p.obtained_at, array[p_card_id], to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint), true);
  end if;
  p.owned := jsonb_set(p.owned, array[p_card_id], to_jsonb(v_prev + 1), true);

  update public.profiles set abris = p.abris, owned = p.owned, obtained_at = p.obtained_at where id = uid;
  return jsonb_build_object('profile', private.profile_json(p), 'price', v_price, 'is_new', v_prev = 0);
end;
$$;
revoke all on function public.buy_card(text) from public, anon;
grant execute on function public.buy_card(text) to authenticated;
