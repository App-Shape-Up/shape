/* Shape — app de saúde. Versão 1: módulo Água.
 *
 * O app conversa com o banco através do objeto `banco`, que tem duas versões:
 *  - Nuvem: Supabase (login + dados de cada pessoa separados)
 *  - Demo: guarda só neste navegador, usado quando config.js está vazio
 * Os próximos módulos (treinos, dieta...) só precisam de novas funções aqui.
 */
(function () {
  'use strict';

  const META_PADRAO_ML = 2500;
  const cfg = window.SHAPE_CONFIG || {};
  const modoDemo = !(cfg.supabaseUrl && cfg.supabaseKey);

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const dd = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate());
  const hoje = () => iso(new Date());
  const somaDias = (dia, n) => { const d = new Date(dia + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const fmt = (n) => Number(n).toLocaleString('pt-BR') + ' ml';
  const horaDe = (ts) => { const d = new Date(ts); return dd(d.getHours()) + ':' + dd(d.getMinutes()); };

  let avisoTimer;
  function avisar(txt) {
    const a = $('aviso'); a.textContent = txt; a.classList.add('ver');
    clearTimeout(avisoTimer); avisoTimer = setTimeout(() => a.classList.remove('ver'), 2400);
  }
  function msgErro(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(m)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
    if (/already registered/i.test(m)) return 'Esse e-mail já tem conta. Use "Entrar".';
    if (/Password should be/i.test(m)) return 'A senha precisa ter pelo menos 6 caracteres.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão com a internet.';
    if (/schema cache|does not exist|relation .* not found/i.test(m)) return 'O banco ainda não tem as tabelas. Rode o arquivo schema.sql no SQL Editor do Supabase.';
    if (/permission denied/i.test(m)) return 'O banco recusou o acesso. Rode de novo o arquivo schema.sql no SQL Editor do Supabase.';
    return m;
  }

  // ---------- Banco: nuvem (Supabase) ----------
  function bancoNuvem() {
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    return {
      async usuario() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
      aoMudarLogin(fn) { sb.auth.onAuthStateChange((_ev, s) => fn(s ? s.user : null)); },
      async entrar(email, senha) { ok(await sb.auth.signInWithPassword({ email, password: senha })); },
      async criarConta(email, senha) {
        const data = ok(await sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.href.split('#')[0] } }));
        return { precisaConfirmar: !data.session };
      },
      async sair() { await sb.auth.signOut(); },

      async listarAgua(desde, ate) {
        return ok(await sb.from('agua_registros').select('id, dia, quantidade_ml, registrado_em')
          .gte('dia', desde).lte('dia', ate).order('registrado_em', { ascending: false }));
      },
      async adicionarAgua(dia, ml) { ok(await sb.from('agua_registros').insert({ dia, quantidade_ml: ml })); },
      async removerAgua(id) { ok(await sb.from('agua_registros').delete().eq('id', id)); },
      async listarMetas(modulo, tipo) {
        return ok(await sb.from('metas').select('valor, valida_desde, registrado_em')
          .eq('modulo', modulo).eq('tipo', tipo)
          .order('valida_desde', { ascending: true }).order('registrado_em', { ascending: true }));
      },
      async definirMeta(modulo, tipo, valor, unidade, dia) {
        ok(await sb.from('metas').insert({ modulo, tipo, valor, unidade, valida_desde: dia }));
      },
    };
  }

  // ---------- Banco: demonstração (só neste navegador) ----------
  function bancoDemo() {
    const CHAVE = 'shape-demo-v2';
    const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || { agua: [], metas: [] }; } catch (e) { return { agua: [], metas: [] }; } };
    const gravar = (d) => { try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* sem armazenamento */ } };
    const id = () => Math.random().toString(36).slice(2);
    let logado = true;
    return {
      async usuario() { return logado ? { email: 'demo' } : null; },
      aoMudarLogin() {},
      async entrar() { logado = true; },
      async criarConta() { logado = true; return { precisaConfirmar: false }; },
      async sair() { logado = false; },
      async listarAgua(desde, ate) {
        return ler().agua.filter((r) => r.dia >= desde && r.dia <= ate)
          .sort((a, b) => (a.registrado_em < b.registrado_em ? 1 : -1));
      },
      async adicionarAgua(dia, ml) { const d = ler(); d.agua.push({ id: id(), dia, quantidade_ml: ml, registrado_em: new Date().toISOString() }); gravar(d); },
      async removerAgua(rid) { const d = ler(); d.agua = d.agua.filter((r) => r.id !== rid); gravar(d); },
      async listarMetas(modulo, tipo) {
        return ler().metas.filter((m) => m.modulo === modulo && m.tipo === tipo)
          .sort((a, b) => (a.valida_desde + a.registrado_em < b.valida_desde + b.registrado_em ? -1 : 1));
      },
      async definirMeta(modulo, tipo, valor, unidade, dia) {
        const d = ler(); d.metas.push({ modulo, tipo, valor, unidade, valida_desde: dia, registrado_em: new Date().toISOString() }); gravar(d);
      },
    };
  }

  const banco = modoDemo ? bancoDemo() : bancoNuvem();

  // ---------- Telas ----------
  function mostrar(tela) {
    $('tela-login').classList.toggle('escondido', tela !== 'login');
    $('tela-app').classList.toggle('escondido', tela !== 'app');
  }

  // Login
  let criando = false;
  $('btn-alternar').onclick = () => {
    criando = !criando;
    $('btn-entrar').textContent = criando ? 'Criar conta' : 'Entrar';
    $('btn-alternar').textContent = criando ? 'Já tem conta? Entrar' : 'Não tem conta? Criar conta';
    $('senha').autocomplete = criando ? 'new-password' : 'current-password';
    $('msg-login').textContent = '';
  };
  $('form-login').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = $('msg-login'); msg.className = 'msg'; msg.textContent = 'Aguarde...';
    const email = $('email').value.trim().toLowerCase(), senha = $('senha').value;
    try {
      if (criando) {
        const r = await banco.criarConta(email, senha);
        if (r.precisaConfirmar) { msg.textContent = 'Conta criada! Abra o e-mail que enviamos e toque no link para confirmar. Depois é só entrar.'; return; }
      } else {
        await banco.entrar(email, senha);
      }
      msg.textContent = '';
      abrirApp();
    } catch (e) { msg.className = 'msg erro'; msg.textContent = msgErro(e); }
  };
  $('ver-senha').onchange = () => { $('senha').type = $('ver-senha').checked ? 'text' : 'password'; };
  $('btn-sair').onclick = async () => { await banco.sair(); mostrar('login'); };

  // ---------- Módulo Água ----------
  let diaAberto = hoje();

  function metaNoDia(metas, dia) {
    let valor = META_PADRAO_ML;
    metas.forEach((m) => { if (m.valida_desde <= dia) valor = Number(m.valor); });
    return valor;
  }

  async function carregar() {
    $('tela-app').classList.add('carregando');
    try {
      diaAberto = hoje();
      const desde = somaDias(diaAberto, -6);
      const [regs, metas] = await Promise.all([
        banco.listarAgua(desde, diaAberto),
        banco.listarMetas('agua', 'diaria'),
      ]);
      desenhar(regs, metas);
    } catch (e) {
      avisar('Erro: ' + msgErro(e));
    } finally {
      $('tela-app').classList.remove('carregando');
    }
  }

  function desenhar(regs, metas) {
    const doDia = regs.filter((r) => r.dia === diaAberto);
    const total = doDia.reduce((t, r) => t + r.quantidade_ml, 0);
    const meta = metaNoDia(metas, diaAberto);
    const pct = Math.round((total / meta) * 100);

    $('total').textContent = fmt(total);
    $('meta').textContent = 'meta: ' + fmt(meta);
    $('pct').textContent = pct + '%';
    $('arco').style.strokeDashoffset = 351.86 * (1 - Math.min(pct, 100) / 100);
    $('arco').style.stroke = pct >= 100 ? 'var(--ok)' : 'var(--accent)';
    const falta = meta - total;
    $('falta').textContent = falta > 0 ? 'Faltam ' + fmt(falta) : 'Meta batida! 🎉';
    $('falta').className = 'falta' + (falta > 0 ? '' : ' ok');
    $('nova-meta').placeholder = 'atual: ' + meta;

    const lista = $('lista'); lista.innerHTML = '';
    if (!doDia.length) lista.innerHTML = '<li class="vazio">Nenhum registro hoje ainda.</li>';
    doDia.forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = '<div><span class="hora"></span><span class="ml"></span></div><button aria-label="Apagar">✕</button>';
      li.querySelector('.hora').textContent = horaDe(r.registrado_em);
      li.querySelector('.ml').textContent = fmt(r.quantidade_ml);
      li.querySelector('button').onclick = () => {
        if (confirm('Apagar ' + fmt(r.quantidade_ml) + ' das ' + horaDe(r.registrado_em) + '?')) acao(() => banco.removerAgua(r.id), 'Apagado');
      };
      lista.appendChild(li);
    });

    const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const dias = [];
    for (let i = 6; i >= 0; i--) {
      const dia = somaDias(diaAberto, -i);
      dias.push({ dia, total: regs.filter((r) => r.dia === dia).reduce((t, r) => t + r.quantidade_ml, 0), meta: metaNoDia(metas, dia) });
    }
    const maior = Math.max(...dias.map((d) => Math.max(d.total, d.meta)));
    const semana = $('semana'); semana.innerHTML = '';
    dias.forEach((d) => {
      const el = document.createElement('div'); el.className = 'dia';
      el.title = d.dia + ': ' + fmt(d.total) + ' de ' + fmt(d.meta);
      el.innerHTML = '<span class="v"></span><div class="barra-wrap"><div class="barra"></div></div><span class="n"></span>';
      el.querySelector('.v').textContent = d.total ? (d.total / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'L' : '';
      el.querySelector('.n').textContent = d.dia === diaAberto ? 'hoje' : nomes[new Date(d.dia + 'T12:00:00').getDay()];
      const b = el.querySelector('.barra');
      b.style.height = (d.total / maior) * 100 + '%';
      if (d.total >= d.meta) b.classList.add('bateu');
      semana.appendChild(el);
    });
  }

  async function acao(fn, sucesso) {
    $('tela-app').classList.add('carregando');
    try { await fn(); await carregar(); if (sucesso) avisar(sucesso); return true; }
    catch (e) { avisar('Erro: ' + msgErro(e)); $('tela-app').classList.remove('carregando'); return false; }
  }

  function adicionar(valor) {
    const ml = Math.round(Number(valor));
    if (!(ml > 0 && ml <= 5000)) { avisar('Digite uma quantidade entre 1 e 5000 ml'); return; }
    acao(() => banco.adicionarAgua(hoje(), ml), '+' + fmt(ml));
  }
  document.querySelectorAll('[data-ml]').forEach((b) => { b.onclick = () => adicionar(b.dataset.ml); });
  $('add-outro').onclick = () => { adicionar($('outro').value); $('outro').value = ''; };
  $('outro').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-outro').click(); });
  $('salvar-meta').onclick = async () => {
    const v = Math.round(Number($('nova-meta').value));
    if (!(v >= 250 && v <= 10000)) { avisar('A meta deve ficar entre 250 e 10.000 ml'); return; }
    if (await acao(() => banco.definirMeta('agua', 'diaria', v, 'ml', hoje()), 'Meta salva: ' + fmt(v))) $('nova-meta').value = '';
  };

  // Se o app ficar aberto e virar o dia, recarrega ao voltar para ele
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('tela-app').classList.contains('escondido') && hoje() !== diaAberto) carregar();
  });

  function abrirApp() {
    const t = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' });
    $('data-hoje').textContent = t.charAt(0).toUpperCase() + t.slice(1);
    $('faixa-demo').classList.toggle('escondido', !modoDemo);
    $('btn-sair').classList.toggle('escondido', modoDemo);
    mostrar('app');
    carregar();
  }

  // ---------- Início ----------
  (async () => {
    banco.aoMudarLogin((u) => { if (!u) mostrar('login'); });
    const u = await banco.usuario();
    if (u) abrirApp(); else mostrar('login');
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
