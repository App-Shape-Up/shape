// Endereço e chave pública do banco Supabase.
// Esses dois valores são públicos por natureza (ficam no navegador de todo mundo);
// quem protege os dados são as regras de segurança do banco (supabase/schema.sql).
// Se estiverem vazios, o app roda em MODO DEMONSTRAÇÃO, guardando só neste navegador.
window.SHAPE_CONFIG = {
  supabaseUrl: 'https://skvdkekkdqlpefmylqcw.supabase.co',
  supabaseKey: 'sb_publishable_DEdaqv-zkMGh82r9q2OOPA_ITlUIx_D',
};
