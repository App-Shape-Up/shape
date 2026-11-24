/* Shape — app pessoal de saúde. Versão 1: módulo Água.
 *
 * Onde ficam os dados: numa planilha "Shape - dados" no Google Drive de cada pessoa.
 * Não existe servidor nosso: o navegador conversa direto com o Google.
 * Permissão pedida: drive.file = o app só enxerga os arquivos que ele mesmo criou.
 *
 * Funciona sem internet: tudo é salvo primeiro no aparelho (fila de pendências)
 * e enviado para a planilha quando houver conexão.
 *
 * Para criar um módulo novo (treinos, dieta...): adicione a aba em TABELAS,
 * e o app cria a aba nas planilhas que já existem na próxima sincronização.
 */
(function () {
  'use strict';

  // ---------- Estrutura da planilha ----------
  const NOME_PLANILHA = 'Shape - dados';
  const TABELAS = {
    Agua:  ['id', 'dia', 'quantidade_ml', 'registrado_em'],
    Metas: ['id', 'modulo', 'tipo', 'valor', 'unidade', 'valida_desde', 'registrado_em'],
  };
  // Abas de leitura (fórmulas) para o painel. O app cria uma vez e não mexe mais.
  const ABAS_RESUMO = {
    'Resumo Agua': [['=QUERY(Agua!B:C, "select B, sum(C), count(C) where B is not null group by B order by B desc label B \'dia\', sum(C) \'total_ml\', count(C) \'vezes\'", 1)']],
  };
  const META_PADRAO_ML = 2500;

  const cfg = window.SHAPE_CONFIG || {};
  const modoDemo = !cfg.googleClientId;
  const ESCOPOS = 'openid email https://www.googleapis.com/auth/drive.file';

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const dd = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + dd(d.getMonth() + 1) + '-' + dd(d.getDate());
  const hoje = () => iso(new Date());
  const somaDias = (dia, n) => { const d = new Date(dia + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const fmt = (n) => Number(n).toLocaleString('pt-BR') + ' ml';
  const horaDe = (ts) => { const d = new Date(ts); return dd(d.getHours()) + ':' + dd(d.getMinutes()); };
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const base = () => location.origin + location.pathname.replace(/index\.html$/, '');

  const guardar = {
    ler(k, padrao) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; } },
    gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } },
    apagar(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
  };

  let avisoTimer;
  function avisar(txt) {
    const a = $('aviso'); a.textContent = txt; a.classList.add('ver');
    clearTimeout(avisoTimer); avisoTimer = setTimeout(() => a.classList.remove('ver'), 2600);
  }

  // ---------- Dados locais (cópia no aparelho + fila de pendências) ----------
  // estado = { agua: [...], metas: [...], fila: [{op:'add'|'del', tabela, item|id}] }
  const CHAVE_DADOS = modoDemo ? 'shape-demo-v3' : 'shape-dados-v3';
  let estado = guardar.ler(CHAVE_DADOS, { agua: [], metas: [], fila: [] });
  const salvarEstado = () => guardar.gravar(CHAVE_DADOS, estado);
  const listaDe = (tabela) => (tabela === 'Agua' ? estado.agua : estado.metas);

  function registrar(tabela, item) {
    listaDe(tabela).push(item);
    if (!modoDemo) estado.fila.push({ op: 'add', tabela, item });
    salvarEstado();
  }
  function remover(tabela, id) {
    if (tabela === 'Agua') estado.agua = estado.agua.filter((r) => r.id !== id);
    else estado.metas = estado.metas.filter((r) => r.id !== id);
    if (!modoDemo) {
      const antes = estado.fila.length;
      // se ainda não tinha subido para a planilha, basta tirar da fila
      estado.fila = estado.fila.filter((f) => !(f.op === 'add' && f.item.id === id));
      if (estado.fila.length === antes) estado.fila.push({ op: 'del', tabela, id });
    }
    salvarEstado();
  }

  // ---------- Login com Google (redirecionamento, funciona no app da tela de início) ----------
  const CHAVE_TOKEN = 'shape-token';
  const CHAVE_CONTA = 'shape-conta';
  let token = guardar.ler(CHAVE_TOKEN, null);     // { valor, expira }
  let conta = guardar.ler(CHAVE_CONTA, null);     // { email }
  const tokenValido = () => token && token.expira > Date.now() + 60000;

  function irParaGoogle(silencioso) {
    const st = novoId();
    try { sessionStorage.setItem('shape-state', st); } catch (e) { /* */ }
    const p = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: base(),
      response_type: 'token',
      scope: ESCOPOS,
      include_granted_scopes: 'true',
      state: st,
    });
    if (conta && conta.email) p.set('login_hint', conta.email);
    if (silencioso) p.set('prompt', 'none');
    else if (!conta) p.set('prompt', 'consent select_account');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
  }

  // Volta do Google: o token vem depois do "#" no endereço
  function lerRetornoDoGoogle() {
    if (!location.hash || location.hash.length < 2) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has('access_token') && !h.has('error')) return null;
    history.replaceState(null, '', base());
    let esperado = null;
    try { esperado = sessionStorage.getItem('shape-state'); sessionStorage.removeItem('shape-state'); } catch (e) { /* */ }
    if (h.get('state') !== esperado) return { erro: 'state' };
    if (h.has('error')) return { erro: h.get('error') };
    if (!String(h.get('scope') || '').includes('drive.file')) return { erro: 'sem_drive' };
    token = { valor: h.get('access_token'), expira: Date.now() + Number(h.get('expires_in') || 3600) * 1000 };
    guardar.gravar(CHAVE_TOKEN, token);
    return { ok: true };
  }

  function sair() {
    if (token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token.valor), { method: 'POST' }).catch(() => {});
    token = null; conta = null;
    [CHAVE_TOKEN, CHAVE_CONTA, CHAVE_DADOS, 'shape-planilha', 'shape-renovou', 'shape-sinc'].forEach(guardar.apagar);
    estado = { agua: [], metas: [], fila: [] };
    mostrar('login');
  }

  // ---------- Google Drive / Sheets ----------
  class ErroGoogle extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  async function google(url, opcoes) {
    opcoes = opcoes || {};
    const r = await fetch(url, {
      method: opcoes.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token.valor }, opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    if (!r.ok) {
      let msg = r.status + '';
      try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) { /* */ }
      throw new ErroGoogle(r.status, msg);
    }
    return r.status === 204 ? null : r.json();
  }
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const faixa = (aba, resto) => encodeURIComponent("'" + aba + "'" + (resto || ''));

  let planilha = guardar.ler('shape-planilha', null); // { id, abas: {nome: sheetId} }

  async function achaOuCriaPlanilha() {
    if (planilha && planilha.id) {
      try { await carregaAbas(planilha.id); return; }
      catch (e) { if (e.status !== 404 && e.status !== 403) throw e; planilha = null; }
    }
    const q = "name='" + NOME_PLANILHA + "' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    const r = await google(DRIVE + '?q=' + encodeURIComponent(q) + '&fields=files(id)&orderBy=createdTime&pageSize=1');
    if (r.files && r.files.length) { await carregaAbas(r.files[0].id); return; }

    const nova = await google(SHEETS, { method: 'POST', body: {
      properties: { title: NOME_PLANILHA, locale: 'pt_BR' },
      sheets: Object.keys(TABELAS).concat(Object.keys(ABAS_RESUMO)).map((t) => ({ properties: { title: t, gridProperties: { frozenRowCount: TABELAS[t] ? 1 : 0 } } })),
    } });
    await google(SHEETS + '/' + nova.spreadsheetId + '/values:batchUpdate', { method: 'POST', body: {
      valueInputOption: 'USER_ENTERED',
      data: Object.keys(TABELAS).map((t) => ({ range: "'" + t + "'!A1", values: [TABELAS[t]] }))
        .concat(Object.keys(ABAS_RESUMO).map((t) => ({ range: "'" + t + "'!A1", values: ABAS_RESUMO[t] }))),
    } });
    await carregaAbas(nova.spreadsheetId);
  }

  async function carregaAbas(id) {
    const r = await google(SHEETS + '/' + id + '?fields=sheets.properties(sheetId,title)');
    const abas = {};
    r.sheets.forEach((s) => { abas[s.properties.title] = s.properties.sheetId; });
    // módulo novo no app? cria a aba que falta
    const faltando = Object.keys(TABELAS).filter((t) => !(t in abas));
    if (faltando.length) {
      const add = await google(SHEETS + '/' + id + ':batchUpdate', { method: 'POST', body: {
        requests: faltando.map((t) => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } })),
      } });
      add.replies.forEach((rep) => { abas[rep.addSheet.properties.title] = rep.addSheet.properties.sheetId; });
      await google(SHEETS + '/' + id + '/values:batchUpdate', { method: 'POST', body: {
        valueInputOption: 'RAW', data: faltando.map((t) => ({ range: "'" + t + "'!A1", values: [TABELAS[t]] })),
      } });
    }
    planilha = { id, abas };
    guardar.gravar('shape-planilha', planilha);
  }

  const paraLinha = (tabela, item) => TABELAS[tabela].map((c) => (item[c] === undefined ? '' : item[c]));
  function deLinha(tabela, linha) {
    const o = {};
    TABELAS[tabela].forEach((c, i) => { o[c] = linha[i] === undefined ? '' : linha[i]; });
    // se alguém editou a planilha à mão, a data pode ter virado número de série
    ['dia', 'valida_desde'].forEach((c) => {
      if (typeof o[c] === 'number') o[c] = iso(new Date(Date.UTC(1899, 11, 30) + o[c] * 86400000 + 43200000));
    });
    if (tabela === 'Agua') o.quantidade_ml = Number(o.quantidade_ml) || 0;
    if (tabela === 'Metas') o.valor = Number(o.valor) || 0;
    return o;
  }

  async function enviarFila() {
    while (estado.fila.length) {
      const f = estado.fila[0];
      if (f.op === 'add') {
        await google(SHEETS + '/' + planilha.id + '/values/' + faixa(f.tabela, '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
          { method: 'POST', body: { values: [paraLinha(f.tabela, f.item)] } });
      } else {
        const col = await google(SHEETS + '/' + planilha.id + '/values/' + faixa(f.tabela, '!A:A'));
        const ids = (col.values || []).map((l) => l[0]);
        const idx = ids.lastIndexOf(f.id);
        if (idx > 0) {
          await google(SHEETS + '/' + planilha.id + ':batchUpdate', { method: 'POST', body: {
            requests: [{ deleteDimension: { range: { sheetId: planilha.abas[f.tabela], dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } } }],
          } });
        }
      }
      estado.fila.shift();
      salvarEstado();
    }
  }

  async function baixarTudo() {
    const nomes = Object.keys(TABELAS);
    const r = await google(SHEETS + '/' + planilha.id + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' +
      nomes.map((t) => 'ranges=' + faixa(t, '!A2:' + String.fromCharCode(64 + TABELAS[t].length))).join('&'));
    const dados = {};
    nomes.forEach((t, i) => { dados[t] = (r.valueRanges[i].values || []).filter((l) => l[0]).map((l) => deLinha(t, l)); });
    // reaplica o que foi registrado enquanto baixava (ainda na fila)
    estado.fila.forEach((f) => {
      const t = f.tabela === 'Agua' ? 'Agua' : 'Metas';
      if (f.op === 'add') dados[t].push(f.item);
      else dados[t] = dados[t].filter((r) => r.id !== f.id);
    });
    estado.agua = dados.Agua;
    estado.metas = dados.Metas;
    salvarEstado();
  }

  // ---------- Sincronização ----------
  let sincronizando = false;
  let ultimoErro = '';
  async function sincronizar() {
    if (modoDemo || sincronizando) return;
    if (!navigator.onLine) { atualizarStatus(); return; }
    if (!tokenValido()) {
      // renova o acesso sem perguntar nada (no máximo uma vez a cada 2 minutos)
      const ult = Number(guardar.ler('shape-renovou', 0));
      if (Date.now() - ult > 120000) { guardar.gravar('shape-renovou', Date.now()); irParaGoogle(true); }
      else { ultimoErro = 'Toque em "Sincronizar" para entrar de novo no Google.'; atualizarStatus(); }
      return;
    }
    sincronizando = true; atualizarStatus();
    try {
      if (!conta) {
        const u = await google('https://www.googleapis.com/oauth2/v3/userinfo');
        conta = { email: u.email }; guardar.gravar(CHAVE_CONTA, conta);
      }
      await achaOuCriaPlanilha();
      await enviarFila();
      await baixarTudo();
      ultimoErro = '';
      guardar.gravar('shape-sinc', Date.now());
    } catch (e) {
      if (e.status === 401) { token = null; guardar.apagar(CHAVE_TOKEN); }
      ultimoErro = e.status === 403 ? 'O Google recusou o acesso à planilha.' : 'Não consegui sincronizar agora. Tento de novo depois.';
      console.error(e);
    } finally {
      sincronizando = false;
      desenhar(); atualizarStatus();
      if (!ultimoErro && estado.fila.length) setTimeout(sincronizar, 500);
    }
  }

  function atualizarStatus() {
    const el = $('status');
    if (modoDemo) { el.innerHTML = ''; return; }
    const pend = estado.fila.length;
    let txt;
    if (sincronizando) txt = 'Sincronizando com o seu Drive…';
    else if (!navigator.onLine) txt = 'Sem internet. ' + (pend ? pend + ' registro(s) aguardando para subir.' : 'Tudo salvo no aparelho.');
    else if (ultimoErro) txt = ultimoErro;
    else if (pend) txt = pend + ' registro(s) aguardando para subir.';
    else txt = '✓ Salvo no seu Google Drive';
    el.innerHTML = '';
    const s = document.createElement('span'); s.textContent = txt; if (pend || ultimoErro) s.className = 'pend';
    el.appendChild(s);
    if (planilha && planilha.id) {
      const a = document.createElement('a'); a.href = 'https://docs.google.com/spreadsheets/d/' + planilha.id; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Abrir planilha'; el.appendChild(a);
    } else if (ultimoErro) {
      const b = document.createElement('button'); b.className = 'link'; b.textContent = 'Sincronizar';
      b.onclick = () => { guardar.apagar('shape-renovou'); irParaGoogle(false); }; el.appendChild(b);
    }
  }

  // ---------- Telas ----------
  function mostrar(tela) {
    $('tela-login').classList.toggle('escondido', tela !== 'login');
    $('tela-app').classList.toggle('escondido', tela !== 'app');
  }
  $('btn-google').onclick = () => { $('msg-login').textContent = 'Abrindo o Google…'; irParaGoogle(false); };
  $('btn-sair').onclick = () => {
    if (estado.fila.length && !confirm('Há ' + estado.fila.length + ' registro(s) que ainda não subiram para o Drive e serão perdidos. Sair mesmo assim?')) return;
    sair();
  };

  // ---------- Módulo Água ----------
  let diaAberto = hoje();

  function metaNoDia(dia) {
    const ms = estado.metas.filter((m) => m.modulo === 'agua' && m.tipo === 'diaria' && String(m.valida_desde) <= dia)
      .sort((a, b) => (String(a.valida_desde) + a.registrado_em < String(b.valida_desde) + b.registrado_em ? -1 : 1));
    return ms.length ? Number(ms[ms.length - 1].valor) : META_PADRAO_ML;
  }

  function desenhar() {
    diaAberto = hoje();
    const doDia = estado.agua.filter((r) => r.dia === diaAberto)
      .sort((a, b) => (a.registrado_em < b.registrado_em ? 1 : -1));
    const total = doDia.reduce((t, r) => t + r.quantidade_ml, 0);
    const meta = metaNoDia(diaAberto);
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
        if (!confirm('Apagar ' + fmt(r.quantidade_ml) + ' das ' + horaDe(r.registrado_em) + '?')) return;
        remover('Agua', r.id); desenhar(); atualizarStatus(); avisar('Apagado'); sincronizar();
      };
      lista.appendChild(li);
    });

    const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const dias = [];
    for (let i = 6; i >= 0; i--) {
      const dia = somaDias(diaAberto, -i);
      dias.push({ dia, total: estado.agua.filter((r) => r.dia === dia).reduce((t, r) => t + r.quantidade_ml, 0), meta: metaNoDia(dia) });
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

  function adicionar(valor) {
    const ml = Math.round(Number(valor));
    if (!(ml > 0 && ml <= 5000)) { avisar('Digite uma quantidade entre 1 e 5000 ml'); return; }
    registrar('Agua', { id: novoId(), dia: hoje(), quantidade_ml: ml, registrado_em: new Date().toISOString() });
    desenhar(); atualizarStatus(); avisar('+' + fmt(ml)); sincronizar();
  }
  document.querySelectorAll('[data-ml]').forEach((b) => { b.onclick = () => adicionar(b.dataset.ml); });
  $('add-outro').onclick = () => { adicionar($('outro').value); $('outro').value = ''; };
  $('outro').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-outro').click(); });
  $('salvar-meta').onclick = () => {
    const v = Math.round(Number($('nova-meta').value));
    if (!(v >= 250 && v <= 10000)) { avisar('A meta deve ficar entre 250 e 10.000 ml'); return; }
    registrar('Metas', { id: novoId(), modulo: 'agua', tipo: 'diaria', valor: v, unidade: 'ml', valida_desde: hoje(), registrado_em: new Date().toISOString() });
    $('nova-meta').value = ''; desenhar(); atualizarStatus(); avisar('Meta salva: ' + fmt(v)); sincronizar();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || $('tela-app').classList.contains('escondido')) return;
    desenhar(); sincronizar();
  });
  window.addEventListener('online', sincronizar);
  window.addEventListener('offline', atualizarStatus);

  function abrirApp() {
    const t = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' });
    $('data-hoje').textContent = t.charAt(0).toUpperCase() + t.slice(1);
    $('faixa-demo').classList.toggle('escondido', !modoDemo);
    $('btn-sair').classList.toggle('escondido', modoDemo);
    $('tela-app').classList.remove('carregando');
    mostrar('app');
    desenhar(); atualizarStatus(); sincronizar();
  }

  // ---------- Início ----------
  (function iniciar() {
    if (modoDemo) { abrirApp(); return; }
    const ret = lerRetornoDoGoogle();
    if (ret && ret.erro) {
      const jaEntrou = !!conta;
      if (jaEntrou && (ret.erro === 'interaction_required' || ret.erro === 'login_required' || ret.erro === 'consent_required')) {
        ultimoErro = 'Toque em "Sincronizar" para entrar de novo no Google.';
        abrirApp(); return;
      }
      mostrar('login');
      $('msg-login').className = 'msg erro';
      $('msg-login').textContent = ret.erro === 'access_denied' ? 'Você cancelou a entrada com o Google.'
        : ret.erro === 'sem_drive' ? 'Para guardar seus dados, marque a permissão do Google Drive ao entrar.'
        : 'Não foi possível entrar (' + ret.erro + '). Tente de novo.';
      return;
    }
    if (ret && ret.ok) guardar.apagar('shape-renovou');
    if (tokenValido() || conta) abrirApp(); else mostrar('login');
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
