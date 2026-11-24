-- Shape: estrutura do banco de dados (Supabase / Postgres)
-- Cole tudo no "SQL Editor" do Supabase e clique em "Run". Pode rodar de novo sem estragar nada.
--
-- Regra de ouro: toda tabela tem user_id e "Row Level Security" ligado,
-- então cada pessoa (você, sua mãe...) só enxerga e altera os próprios dados.

-- ---------- Água ----------
create table if not exists public.agua_registros (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dia           date not null,                       -- o dia no fuso da pessoa
  quantidade_ml integer not null check (quantidade_ml between 1 and 5000),
  registrado_em timestamptz not null default now()   -- momento exato do registro
);
create index if not exists agua_registros_user_dia on public.agua_registros (user_id, dia);

-- ---------- Metas (serve para todos os módulos) ----------
-- Nunca se apaga uma meta: cria-se uma nova com "valida_desde".
-- A meta de um dia é a mais recente com valida_desde <= esse dia.
create table if not exists public.metas (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  modulo        text not null,          -- 'agua', depois 'treino', 'dieta', 'habitos'...
  tipo          text not null,          -- 'diaria', 'semanal'...
  valor         numeric not null check (valor > 0),
  unidade       text not null,          -- 'ml', 'treinos', 'kcal'...
  valida_desde  date not null,
  registrado_em timestamptz not null default now()
);
create index if not exists metas_user_modulo on public.metas (user_id, modulo, tipo, valida_desde);

-- ---------- Segurança: cada um só vê o seu ----------
alter table public.agua_registros enable row level security;
alter table public.metas          enable row level security;

drop policy if exists "dono" on public.agua_registros;
create policy "dono" on public.agua_registros
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "dono" on public.metas;
create policy "dono" on public.metas
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Visão pronta para painéis ----------
-- Total por dia + meta válida naquele dia + se bateu. Respeita a segurança de quem consulta.
create or replace view public.agua_por_dia with (security_invoker = true) as
select
  r.user_id,
  r.dia,
  sum(r.quantidade_ml)::int as total_ml,
  count(*)::int             as vezes,
  m.valor::int              as meta_ml,
  (sum(r.quantidade_ml) >= coalesce(m.valor, 2500)) as bateu_meta
from public.agua_registros r
left join lateral (
  select valor from public.metas m
  where m.user_id = r.user_id and m.modulo = 'agua' and m.tipo = 'diaria' and m.valida_desde <= r.dia
  order by m.valida_desde desc, m.registrado_em desc
  limit 1
) m on true
group by r.user_id, r.dia, m.valor;
