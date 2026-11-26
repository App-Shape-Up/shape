/* ShapeUp — app pessoal de saúde. Versão 3: novo visual (verde escuro), tela inicial com cadastros e registro diário,
 * meta de água ajustável no dia, tabela mensal de consumo e backup por e-mail.
 *
 * Onde ficam os dados: numa planilha "Shape - dados" no Google Drive de cada pessoa.
 * Não existe servidor nosso: o navegador conversa direto com o Google.
 * Permissão pedida: drive.file = o app só enxerga os arquivos que ele mesmo criou.
 *
 * Funciona sem internet: tudo é salvo primeiro no aparelho (fila de pendências)
 * e enviado para a planilha quando houver conexão.
 *
 * Para criar um módulo novo (dieta, suplementação...): adicione a aba em TABELAS (e em CHAVES),
 * e o app cria a aba nas planilhas que já existem na próxima sincronização.
 */
(function () {
  'use strict';

  // ---------- Estrutura da planilha ----------
  const NOME_PLANILHA = 'Shape - dados';
  const TABELAS = {
    Agua:    ['id', 'dia', 'quantidade_ml', 'registrado_em'],
    Metas:   ['id', 'modulo', 'tipo', 'valor', 'unidade', 'valida_desde', 'registrado_em'],
    Perfil:  ['id', 'idade', 'peso_kg', 'altura_cm', 'tempo_treino', 'condicionamento', 'objetivo', 'registrado_em'],
    Treinos: ['id', 'dia', 'tipo', 'minutos', 'registrado_em', 'treino_id'],
    // Cadastros (a pessoa monta uma vez e usa no dia a dia)
    'Cad Treinos':     ['id', 'nome', 'tipo', 'exercicios', 'obs', 'registrado_em'],
    'Cad Exercicios':  ['id', 'nome', 'grupo', 'obs', 'registrado_em'],
    'Cad Alimentos':   ['id', 'nome', 'porcao', 'kcal', 'proteina_g', 'carbo_g', 'gordura_g', 'registrado_em'],
    'Cad Suplementos': ['id', 'nome', 'dose', 'horario', 'obs', 'registrado_em'],
  };
  // nome da lista no aparelho para cada aba
  const CHAVES = {
    Agua: 'agua', Metas: 'metas', Perfil: 'perfil', Treinos: 'treinos',
    'Cad Treinos': 'cadTreinos', 'Cad Exercicios': 'cadExercicios', 'Cad Alimentos': 'cadAlimentos', 'Cad Suplementos': 'cadSuplementos',
  };
  const NUMEROS = {
    Agua: ['quantidade_ml'], Metas: ['valor'], Perfil: ['idade', 'peso_kg', 'altura_cm'], Treinos: ['minutos'],
    'Cad Alimentos': ['kcal', 'proteina_g', 'carbo_g', 'gordura_g'],
  };
  const ESCOPO_GMAIL = 'https://www.googleapis.com/auth/gmail.send';
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
  const fmt = (n) => Math.round(Number(n)).toLocaleString('pt-BR') + ' ml';
  const litros = (n) => (Number(n) / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' L';
  const horaDe = (ts) => { const d = new Date(ts); return dd(d.getHours()) + ':' + dd(d.getMinutes()); };
  const diaDe = (ts) => iso(new Date(ts));
  const diaCurto = (dia) => { const [, m, d] = dia.split('-'); return d + '/' + m; };
  const NOMES_DIA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const semanaDe = (dia) => NOMES_DIA[new Date(dia + 'T12:00:00').getDay()];
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const base = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

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
  // estado = { agua: [...], metas: [...], perfil: [...], treinos: [...], fila: [{op:'add'|'del', tabela, item|id}] }
  const CHAVE_DADOS = modoDemo ? 'shape-demo-v3' : 'shape-dados-v3';
  const estadoVazio = () => { const e = { fila: [] }; Object.values(CHAVES).forEach((k) => { e[k] = []; }); return e; };
  let estado = Object.assign(estadoVazio(), guardar.ler(CHAVE_DADOS, {}));
  const salvarEstado = () => guardar.gravar(CHAVE_DADOS, estado);
  const listaDe = (tabela) => estado[CHAVES[tabela]];

  function registrar(tabela, item) {
    listaDe(tabela).push(item);
    if (!modoDemo) estado.fila.push({ op: 'add', tabela, item });
    salvarEstado();
  }
  function remover(tabela, id) {
    estado[CHAVES[tabela]] = listaDe(tabela).filter((r) => r.id !== id);
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

  const temEscopo = (e) => !!(token && token.escopos && token.escopos.indexOf(e) >= 0);
  function irParaGoogle(silencioso, extra) {
    const st = novoId();
    try { sessionStorage.setItem('shape-state', st); } catch (e) { /* */ }
    const p = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: base(),
      response_type: 'token',
      scope: ESCOPOS + (extra ? ' ' + extra : ''),
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
    token = { valor: h.get('access_token'), expira: Date.now() + Number(h.get('expires_in') || 3600) * 1000, escopos: h.get('scope') || '' };
    guardar.gravar(CHAVE_TOKEN, token);
    return { ok: true };
  }

  function sair() {
    if (token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token.valor), { method: 'POST' }).catch(() => {});
    token = null; conta = null;
    [CHAVE_TOKEN, CHAVE_CONTA, CHAVE_DADOS, 'shape-planilha', 'shape-renovou', 'shape-sinc', 'shape-depois'].forEach(guardar.apagar);
    estado = estadoVazio();
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
    // colunas novas em abas antigas: atualiza a linha de títulos (uma vez por versão do app)
    const versao = Object.keys(TABELAS).map((t) => t + ':' + TABELAS[t].length).join(',');
    if (!planilha || planilha.id !== id || planilha.cab !== versao) {
      const nomes = Object.keys(TABELAS).filter((t) => faltando.indexOf(t) < 0);
      const r1 = await google(SHEETS + '/' + id + '/values:batchGet?' + nomes.map((t) => 'ranges=' + faixa(t, '!1:1')).join('&'));
      const corrigir = nomes.filter((t, i) => ((r1.valueRanges[i].values || [[]])[0] || []).join('|') !== TABELAS[t].join('|'));
      if (corrigir.length) {
        await google(SHEETS + '/' + id + '/values:batchUpdate', { method: 'POST', body: {
          valueInputOption: 'RAW', data: corrigir.map((t) => ({ range: "'" + t + "'!A1", values: [TABELAS[t]] })),
        } });
      }
    }
    planilha = { id, abas, cab: versao };
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
    (NUMEROS[tabela] || []).forEach((c) => { if (o[c] !== '') o[c] = Number(String(o[c]).replace(',', '.')) || 0; });
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
      if (!dados[f.tabela]) return;
      if (f.op === 'add') dados[f.tabela].push(f.item);
      else dados[f.tabela] = dados[f.tabela].filter((x) => x.id !== f.id);
    });
    nomes.forEach((t) => { estado[CHAVES[t]] = dados[t]; });
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
    const st = $('status');
    if (modoDemo) { st.innerHTML = ''; return; }
    const pend = estado.fila.length;
    let txt;
    if (sincronizando) txt = 'Sincronizando com o seu Drive…';
    else if (!navigator.onLine) txt = 'Sem internet. ' + (pend ? pend + ' registro(s) aguardando para subir.' : 'Tudo salvo no aparelho.');
    else if (ultimoErro) txt = ultimoErro;
    else if (pend) txt = pend + ' registro(s) aguardando para subir.';
    else txt = '✓ Salvo no seu Google Drive';
    st.innerHTML = '';
    const s = el('span', pend || ultimoErro ? 'pend' : '', txt);
    st.appendChild(s);
    if (ultimoErro) {
      const b = el('button', 'link', 'Sincronizar');
      b.onclick = () => { guardar.apagar('shape-renovou'); irParaGoogle(false); }; st.appendChild(b);
    }
  }

  // ---------- Telas e menu ----------
  function mostrar(tela) {
    $('tela-login').classList.toggle('escondido', tela !== 'login');
    $('tela-app').classList.toggle('escondido', tela !== 'app');
  }
  $('btn-google').onclick = () => { $('msg-login').textContent = 'Abrindo o Google…'; irParaGoogle(false); };
  $('btn-sair').onclick = () => {
    if (estado.fila.length && !confirm('Há ' + estado.fila.length + ' registro(s) que ainda não subiram para o Drive e serão perdidos. Sair mesmo assim?')) return;
    sair();
  };

  // nome: [título, ícone, tela pai (para o botão voltar), bloco da página]
  const SECOES = {
    home: ['ShapeUp', 'logo'],
    perfil: ['Perfil', 'perfil'],
    painel: ['Painel', 'painel'],
    hidratacao: ['Hidratação', 'agua', 'home'],
    treino: ['Treino', 'treino', 'home'],
    dieta: ['Dieta', 'dieta', 'home'],
    suplementacao: ['Suplementação', 'suplemento', 'home'],
    'cad-treino': ['Cadastro de treinos', 'treino', 'home', 'cadastro'],
    'cad-exercicio': ['Cadastro de exercícios', 'exercicio', 'home', 'cadastro'],
    'cad-alimento': ['Cadastro de alimentos', 'dieta', 'home', 'cadastro'],
    'cad-suplemento': ['Cadastro de suplementos', 'suplemento', 'home', 'cadastro'],
  };
  // aba do menu que fica acesa em cada tela
  const MENU_DE = (n) => (SECOES[n][2] || n);
  let secao = guardar.ler('shape-secao', 'home');
  if (secao === 'treinos') secao = 'treino';
  if (!SECOES[secao]) secao = 'home';

  function irPara(nome) {
    if (nome !== secao && secao.indexOf('cad-') === 0) limparFormCad();
    secao = SECOES[nome] ? nome : 'home';
    guardar.gravar('shape-secao', secao);
    const [titulo, icone, pai, bloco] = SECOES[secao];
    document.querySelectorAll('[data-secao]').forEach((s) => s.classList.toggle('escondido', s.dataset.secao !== (bloco || secao)));
    document.querySelectorAll('nav [data-ir]').forEach((b) => {
      const ativo = b.dataset.ir === MENU_DE(secao);
      b.classList.toggle('ativo', ativo);
      b.setAttribute('aria-current', ativo ? 'page' : 'false');
    });
    $('titulo-secao').textContent = titulo;
    $('ic-secao').innerHTML = '<svg' + (icone === 'logo' ? ' class="logo"' : '') + '><use href="#i-' + icone + '"/></svg>';
    $('voltar').classList.toggle('escondido', !pai);
    document.title = secao === 'home' ? 'ShapeUp' : titulo + ' · ShapeUp';
    window.scrollTo(0, 0);
    desenhar();
  }
  document.querySelectorAll('[data-ir]').forEach((b) => { b.onclick = () => irPara(b.dataset.ir); });
  $('voltar').onclick = () => irPara(SECOES[secao][2] || 'home');

  // botões (i): mostram/escondem a explicação
  document.querySelectorAll('[data-info]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
    b.onclick = () => {
      const t = $(b.dataset.info); const abrir = t.classList.contains('escondido');
      t.classList.toggle('escondido', !abrir); b.setAttribute('aria-expanded', String(abrir));
    };
  });

  // ---------- Perfil ----------
  // Cada vez que a pessoa salva o perfil, uma linha nova vai para a aba Perfil (fica o histórico do peso).
  // Para cada dia vale o último perfil salvo até aquele dia; antes do primeiro, vale o primeiro.
  const perfisOrdenados = () => estado.perfil.slice().sort((a, b) => (a.registrado_em < b.registrado_em ? -1 : 1));
  function perfilNoDia(dia) {
    const ps = perfisOrdenados().filter((p) => p.peso_kg > 0);
    if (!ps.length) return null;
    const ate = ps.filter((p) => diaDe(p.registrado_em) <= dia);
    return ate.length ? ate[ate.length - 1] : ps[0];
  }
  const perfilAtual = () => { const ps = perfisOrdenados(); return ps.length ? ps[ps.length - 1] : null; };

  function preencherPerfil() {
    const p = perfilAtual();
    const campos = ['idade', 'peso_kg', 'altura_cm', 'tempo_treino', 'condicionamento', 'objetivo'];
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#form-perfil')) return; // não atrapalha quem está digitando
    campos.forEach((c) => {
      const v = p ? p[c] : '';
      $('p-' + c).value = v === 0 || v === undefined || v === null ? '' : String(v);
    });
    $('perfil-info').textContent = p
      ? 'Última atualização: ' + new Date(p.registrado_em).toLocaleDateString('pt-BR')
      : 'Preencha para o app calcular suas metas de água.';
    $('btn-salvar-perfil').classList.toggle('escondido', !!p);
    $('conta-email').textContent = modoDemo ? 'Modo demonstração (sem conta)' : (conta && conta.email) || 'Conta Google';
  }

  // o botão de salvar só aparece quando algo foi mudado
  ['input', 'change'].forEach((ev) => $('form-perfil').addEventListener(ev, () => $('btn-salvar-perfil').classList.remove('escondido')));
  $('form-perfil').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = (id) => Number(String($(id).value).replace(',', '.'));
    const idade = Math.round(n('p-idade'));
    const peso = Math.round(n('p-peso_kg') * 10) / 10;
    const altura = Math.round(n('p-altura_cm'));
    if (!(peso >= 20 && peso <= 300)) { avisar('Informe o peso em kg (entre 20 e 300)'); $('p-peso_kg').focus(); return; }
    if ($('p-idade').value && !(idade >= 5 && idade <= 120)) { avisar('Idade deve ficar entre 5 e 120 anos'); return; }
    if ($('p-altura_cm').value && !(altura >= 80 && altura <= 250)) { avisar('Altura em centímetros (ex.: 175)'); return; }
    registrar('Perfil', {
      id: novoId(), idade: idade || '', peso_kg: peso, altura_cm: altura || '',
      tempo_treino: $('p-tempo_treino').value, condicionamento: $('p-condicionamento').value, objetivo: $('p-objetivo').value,
      registrado_em: new Date().toISOString(),
    });
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    desenhar(); atualizarStatus(); avisar('Perfil salvo'); sincronizar();
  });

  // ---------- Treinos ----------
  const TIPOS_TREINO = { musculacao: 'Musculação', cardio: 'Cárdio' };

  // Adicional de água (ml) pelos treinos registrados NO MESMO DIA, segundo a tabela do Fernando.
  // Cárdio (com ou sem musculação) usa a tabela do cárdio com o total de minutos do dia;
  // só musculação usa a tabela da musculação.
  function adicionalPorTreino(dia) {
    const ts = estado.treinos.filter((t) => t.dia === dia && t.minutos > 0);
    if (!ts.length) return { ml: 0, treinos: [] };
    const min = ts.reduce((s, t) => s + t.minutos, 0);
    const temCardio = ts.some((t) => t.tipo === 'cardio');
    let ml;
    if (temCardio) ml = min <= 15 ? 100 : min <= 45 ? 200 : min <= 60 ? 350 : 500;
    else ml = min < 15 ? 0 : min <= 45 ? 100 : min <= 60 ? 250 : 400;
    return { ml, treinos: ts, minutos: min, cardio: temCardio };
  }

  let tipoTreino = 'musculacao';
  function escolherTipo(tipo) {
    tipoTreino = tipo;
    document.querySelectorAll('[data-tipo]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tipo === tipo)));
  }
  document.querySelectorAll('[data-tipo]').forEach((b) => { b.onclick = () => escolherTipo(b.dataset.tipo); });
  // escolher um treino cadastrado já acerta o tipo
  $('t-treino').addEventListener('change', () => {
    const c = estado.cadTreinos.find((x) => x.id === $('t-treino').value);
    if (c) escolherTipo(c.tipo === 'Cárdio' ? 'cardio' : 'musculacao');
  });
  const nomeTreinoCad = (id) => { const c = id && estado.cadTreinos.find((x) => x.id === id); return c ? c.nome : ''; };

  $('form-treino').addEventListener('submit', (e) => {
    e.preventDefault();
    const dia = $('t-dia').value || hoje();
    const min = Math.round(Number($('t-minutos').value));
    if (!(min >= 1 && min <= 600)) { avisar('Informe os minutos de treino (1 a 600)'); $('t-minutos').focus(); return; }
    if (dia > hoje()) { avisar('A data não pode ser no futuro'); return; }
    registrar('Treinos', { id: novoId(), dia, tipo: tipoTreino, minutos: min, registrado_em: new Date().toISOString(), treino_id: $('t-treino').value });
    $('t-minutos').value = '';
    desenhar(); atualizarStatus(); avisar(TIPOS_TREINO[tipoTreino] + ': ' + min + ' min'); sincronizar();
  });

  function desenharTreinos() {
    if (!$('t-dia').value) $('t-dia').value = hoje();
    $('t-dia').max = hoje();
    // lista de treinos cadastrados
    const sel = $('t-treino'); const atual = sel.value;
    const cads = estado.cadTreinos.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    $('rot-treino-cad').classList.toggle('escondido', !cads.length);
    sel.innerHTML = '';
    sel.appendChild(el('option', '', '—')).value = '';
    cads.forEach((c) => { const o = el('option', '', c.nome); o.value = c.id; sel.appendChild(o); });
    sel.value = cads.some((c) => c.id === atual) ? atual : '';

    const lista = $('lista-treinos'); lista.innerHTML = '';
    const ts = estado.treinos.slice().sort((a, b) => (a.dia + a.registrado_em < b.dia + b.registrado_em ? 1 : -1)).slice(0, 15);
    if (!ts.length) lista.appendChild(el('li', 'vazio', 'Nenhum treino registrado ainda.'));
    ts.forEach((t) => {
      const li = el('li');
      const d = el('div', 'item-txt');
      const nome = nomeTreinoCad(t.treino_id);
      d.appendChild(el('span', 'ml', (nome || TIPOS_TREINO[t.tipo] || t.tipo) + ' · ' + t.minutos + ' min'));
      d.appendChild(el('small', '', (t.dia === hoje() ? 'hoje' : t.dia === somaDias(hoje(), -1) ? 'ontem' : semanaDe(t.dia) + ' ' + diaCurto(t.dia)) + (nome ? ' · ' + (TIPOS_TREINO[t.tipo] || t.tipo) : '')));
      li.appendChild(d);
      const b = el('button', '', '✕'); b.setAttribute('aria-label', 'Apagar treino');
      b.onclick = () => {
        if (!confirm('Apagar ' + (TIPOS_TREINO[t.tipo] || t.tipo) + ' de ' + t.minutos + ' min (' + diaCurto(t.dia) + ')?')) return;
        remover('Treinos', t.id); desenhar(); atualizarStatus(); avisar('Treino apagado'); sincronizar();
      };
      li.appendChild(b);
      lista.appendChild(li);
    });
  }

  // ---------- Cadastros ----------
  const GRUPOS = ['Peito', 'Costas', 'Ombros', 'Bíceps', 'Tríceps', 'Antebraço', 'Quadríceps', 'Posterior', 'Glúteos', 'Panturrilha', 'Abdômen', 'Corpo inteiro', 'Cárdio'];
  const HORARIOS = ['Ao acordar', 'Café da manhã', 'Almoço', 'Pré-treino', 'Pós-treino', 'Tarde', 'Jantar', 'Antes de dormir'];
  const CADASTROS = {
    'cad-treino': { tabela: 'Cad Treinos', novo: 'Novo treino', lista: 'Treinos cadastrados', vazio: 'Nenhum treino cadastrado ainda.',
      campos: [
        { c: 'nome', rot: 'Nome do treino', ph: 'ex.: Treino A – Peito e tríceps', obrig: true },
        { c: 'tipo', rot: 'Tipo', ops: ['Musculação', 'Cárdio'] },
        { c: 'exercicios', rot: 'Exercícios', multi: 'cadExercicios' },
        { c: 'obs', rot: 'Observação', ph: 'opcional' },
      ],
      resumo: (i) => [i.tipo, i.exercicios ? i.exercicios.split(' | ').length + ' exercício(s)' : ''].filter(Boolean).join(' · ') },
    'cad-exercicio': { tabela: 'Cad Exercicios', novo: 'Novo exercício', lista: 'Exercícios cadastrados', vazio: 'Nenhum exercício cadastrado ainda.',
      campos: [
        { c: 'nome', rot: 'Nome do exercício', ph: 'ex.: Supino reto', obrig: true },
        { c: 'grupo', rot: 'Grupo muscular', ops: GRUPOS },
        { c: 'obs', rot: 'Observação', ph: 'ex.: 4 × 10, descanso 60 s' },
      ],
      resumo: (i) => [i.grupo, i.obs].filter(Boolean).join(' · ') },
    'cad-alimento': { tabela: 'Cad Alimentos', novo: 'Novo alimento', lista: 'Alimentos cadastrados', vazio: 'Nenhum alimento cadastrado ainda.',
      campos: [
        { c: 'nome', rot: 'Alimento', ph: 'ex.: Arroz integral', obrig: true },
        { c: 'porcao', rot: 'Porção', ph: 'ex.: 100 g' },
        { c: 'kcal', rot: 'Calorias (kcal)', num: true },
        { c: 'proteina_g', rot: 'Proteína (g)', num: true },
        { c: 'carbo_g', rot: 'Carboidrato (g)', num: true },
        { c: 'gordura_g', rot: 'Gordura (g)', num: true },
      ],
      resumo: (i) => [i.porcao, i.kcal !== '' ? i.kcal + ' kcal' : '', i.proteina_g !== '' ? i.proteina_g + ' g prot.' : ''].filter(Boolean).join(' · ') },
    'cad-suplemento': { tabela: 'Cad Suplementos', novo: 'Novo suplemento', lista: 'Suplementos cadastrados', vazio: 'Nenhum suplemento cadastrado ainda.',
      campos: [
        { c: 'nome', rot: 'Suplemento', ph: 'ex.: Creatina', obrig: true },
        { c: 'dose', rot: 'Dose', ph: 'ex.: 5 g' },
        { c: 'horario', rot: 'Quando tomar', ops: HORARIOS },
        { c: 'obs', rot: 'Observação', ph: 'opcional' },
      ],
      resumo: (i) => [i.dose, i.horario].filter(Boolean).join(' · ') },
  };
  let editandoCad = null; // item sendo editado

  function limparFormCad() { editandoCad = null; $('form-cad').dataset.de = ''; }

  function montarFormCad(def) {
    const f = $('form-cad');
    if (f.dataset.de === secao) { atualizarEscolhas(def); return; }
    f.dataset.de = secao; f.innerHTML = '';
    let par = null;
    def.campos.forEach((cp) => {
      const lab = el('label', '', cp.rot);
      let campo;
      if (cp.ops) {
        campo = el('select'); campo.appendChild(el('option', '', '—')).value = '';
        cp.ops.forEach((o) => campo.appendChild(el('option', '', o)));
      } else if (cp.multi) {
        campo = el('div', 'escolhas'); campo.dataset.multi = cp.multi;
      } else {
        campo = el('input'); campo.placeholder = cp.ph || '';
        if (cp.num) { campo.type = 'number'; campo.inputMode = 'decimal'; campo.step = 'any'; campo.min = '0'; }
      }
      campo.id = 'cad-' + cp.c;
      lab.appendChild(campo);
      // campos numéricos lado a lado, dois por linha
      if (cp.num) {
        if (!par) { par = el('div', 'duas'); f.appendChild(par); }
        par.appendChild(lab); if (par.children.length === 2) par = null;
      } else { par = null; f.appendChild(lab); }
    });
    const bs = el('div', 'form-botoes');
    const salvar = el('button', 'primario', 'Salvar'); salvar.type = 'submit'; salvar.id = 'cad-salvar';
    const cancelar = el('button', 'cinza escondido', 'Cancelar'); cancelar.type = 'button'; cancelar.id = 'cad-cancelar';
    cancelar.onclick = () => { editandoCad = null; preencherFormCad(def, null); };
    bs.appendChild(salvar); bs.appendChild(cancelar); f.appendChild(bs);
    preencherFormCad(def, null);
  }

  function atualizarEscolhas(def, marcados) {
    def.campos.filter((cp) => cp.multi).forEach((cp) => {
      const box = $('cad-' + cp.c);
      const sel = marcados || Array.from(box.querySelectorAll('[aria-pressed="true"]')).map((b) => b.textContent);
      box.innerHTML = '';
      const opcoes = estado[cp.multi].map((x) => x.nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));
      sel.forEach((n) => { if (opcoes.indexOf(n) < 0) opcoes.push(n); }); // mantém nomes antigos
      if (!opcoes.length) {
        const p = el('div', 'muted pequeno', 'Cadastre exercícios primeiro em ');
        const l = el('button', 'link', 'Cadastro › Exercício'); l.type = 'button'; l.onclick = () => irPara('cad-exercicio');
        p.appendChild(l); box.appendChild(p); return;
      }
      opcoes.forEach((n) => {
        const b = el('button', '', n); b.type = 'button'; b.setAttribute('aria-pressed', String(sel.indexOf(n) >= 0));
        b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
        box.appendChild(b);
      });
    });
  }

  function preencherFormCad(def, item) {
    def.campos.forEach((cp) => { if (!cp.multi) $('cad-' + cp.c).value = item && item[cp.c] !== undefined ? String(item[cp.c]) : ''; });
    atualizarEscolhas(def, item ? def.campos.filter((cp) => cp.multi).reduce((a, cp) => a.concat(item[cp.c] ? String(item[cp.c]).split(' | ') : []), []) : []);
    $('cad-rotulo-form').textContent = item ? 'Editar' : def.novo;
    $('cad-salvar').textContent = item ? 'Salvar alterações' : 'Salvar';
    $('cad-cancelar').classList.toggle('escondido', !item);
  }

  $('form-cad').addEventListener('submit', (e) => {
    e.preventDefault();
    const def = CADASTROS[secao]; if (!def) return;
    const item = { id: editandoCad ? editandoCad.id : novoId() };
    for (const cp of def.campos) {
      if (cp.multi) {
        item[cp.c] = Array.from($('cad-' + cp.c).querySelectorAll('[aria-pressed="true"]')).map((b) => b.textContent).join(' | ');
        continue;
      }
      let v = String($('cad-' + cp.c).value).trim();
      if (cp.obrig && !v) { avisar('Preencha: ' + cp.rot); $('cad-' + cp.c).focus(); return; }
      if (cp.num && v !== '') { v = Number(v.replace(',', '.')); if (!(v >= 0)) { avisar(cp.rot + ': número inválido'); return; } }
      item[cp.c] = v;
    }
    item.registrado_em = new Date().toISOString();
    if (editandoCad) remover(def.tabela, editandoCad.id);
    registrar(def.tabela, item);
    avisar(editandoCad ? 'Alterado' : 'Cadastrado: ' + item.nome);
    editandoCad = null; preencherFormCad(def, null);
    desenhar(); atualizarStatus(); sincronizar();
  });

  function desenharCadastro() {
    const def = CADASTROS[secao];
    montarFormCad(def);
    $('cad-rotulo-lista').textContent = def.lista;
    const lista = $('lista-cad'); lista.innerHTML = '';
    const itens = listaDe(def.tabela).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    if (!itens.length) lista.appendChild(el('li', 'vazio', def.vazio));
    itens.forEach((i) => {
      const li = el('li');
      const t = el('div', 'item-txt'); t.appendChild(el('span', 'ml', i.nome));
      const r = def.resumo(i); if (r) t.appendChild(el('small', '', r));
      li.appendChild(t);
      const ac = el('div', 'acoes');
      const ed = el('button', 'editar', 'Editar');
      ed.onclick = () => { editandoCad = i; preencherFormCad(def, i); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      const ap = el('button', '', '✕'); ap.setAttribute('aria-label', 'Apagar ' + i.nome);
      ap.onclick = () => {
        if (!confirm('Apagar "' + i.nome + '"?')) return;
        if (editandoCad && editandoCad.id === i.id) { editandoCad = null; preencherFormCad(def, null); }
        remover(def.tabela, i.id); desenhar(); atualizarStatus(); avisar('Apagado'); sincronizar();
      };
      ac.appendChild(ed); ac.appendChild(ap); li.appendChild(ac);
      lista.appendChild(li);
    });
  }

  // ---------- Hidratação ----------
  // Meta antiga (V1), digitada à mão: só é usada se a pessoa ainda não preencheu o peso no perfil.
  function metaManualNoDia(dia) {
    const ms = estado.metas.filter((m) => m.modulo === 'agua' && m.tipo === 'diaria' && String(m.valida_desde) <= dia)
      .sort((a, b) => (String(a.valida_desde) + a.registrado_em < String(b.valida_desde) + b.registrado_em ? -1 : 1));
    return ms.length ? Number(ms[ms.length - 1].valor) : META_PADRAO_ML;
  }

  // Meta recomendada trocada pela pessoa só para um dia (aba Metas, tipo "recomendada_dia").
  const alteracoesDoDia = (dia) => estado.metas.filter((m) => m.modulo === 'agua' && m.tipo === 'recomendada_dia' && String(m.valida_desde) === dia)
    .sort((a, b) => (a.registrado_em < b.registrado_em ? -1 : 1));

  // Meta mínima = peso × 30; meta recomendada = peso × 35 + adicional dos treinos do mesmo dia
  // (ou o valor que a pessoa escolheu para aquele dia).
  function metasDoDia(dia) {
    const p = perfilNoDia(dia);
    const a = adicionalPorTreino(dia);
    const m = p
      ? { minima: Math.round(p.peso_kg * 30), recomendada: Math.round(p.peso_kg * 35) + a.ml, adicional: a, peso: p.peso_kg }
      : { minima: metaManualNoDia(dia), recomendada: metaManualNoDia(dia) + a.ml, adicional: a, peso: null };
    m.calculada = m.recomendada;
    const alt = alteracoesDoDia(dia);
    if (alt.length) { m.recomendada = Number(alt[alt.length - 1].valor); m.alterada = true; }
    return m;
  }
  const totalDoDia = (dia) => estado.agua.filter((r) => r.dia === dia).reduce((t, r) => t + r.quantidade_ml, 0);
  const SITUACOES = {
    ruim: { nome: 'Ruim', icone: '✕', cls: 'ruim' },
    bom: { nome: 'Bom', icone: '!', cls: 'bom' },
    excelente: { nome: 'Excelente', icone: '✓', cls: 'excelente' },
  };
  const situacao = (total, m) => (total >= m.recomendada ? 'excelente' : total >= m.minima ? 'bom' : 'ruim');
  function chip(sit) {
    const s = SITUACOES[sit];
    const c = el('span', 'chip ' + s.cls);
    c.appendChild(el('span', 'chip-ic', s.icone)); c.appendChild(document.createTextNode(s.nome));
    return c;
  }
  // primeiro dia em que a pessoa usou o app (para não contar dias antes disso)
  function primeiroDia() {
    const dias = estado.agua.map((r) => r.dia).filter(Boolean).sort();
    return dias.length ? dias[0] : hoje();
  }

  function descreverAdicional(a) {
    if (!a.treinos.length) return '';
    const tipo = a.cardio ? (a.treinos.some((t) => t.tipo === 'musculacao') ? 'cárdio + musculação' : 'cárdio') : 'musculação';
    return 'Treino de hoje: ' + tipo + ', ' + a.minutos + ' min.';
  }
  const pctTxt = (v) => Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';

  function desenharHidratacao() {
    const dia = hoje();
    const m = metasDoDia(dia);
    $('h-minima').textContent = fmt(m.minima);
    $('h-recomendada').textContent = fmt(m.recomendada);
    const kg = m.peso ? m.peso.toLocaleString('pt-BR') + ' kg' : '';
    $('h-conta-min').textContent = m.peso ? kg + ' × 30' : 'meta antiga (sem peso no perfil)';
    $('h-conta-rec').innerHTML = '';
    if (m.alterada) {
      $('h-conta-rec').textContent = 'alterada por você (calculada: ' + fmt(m.calculada) + ')';
    } else {
      [m.peso ? kg + ' × 35' : 'meta antiga', '+', 'Adicional treino = ' + fmt(m.adicional.ml)].forEach((t) => $('h-conta-rec').appendChild(el('div', '', t)));
    }
    $('h-adicional').textContent = descreverAdicional(m.adicional);
    $('h-sem-perfil').classList.toggle('escondido', !!m.peso);
    const ma = $('h-meta-alterada'); ma.innerHTML = ''; ma.className = 'nota-meta';
    if (m.alterada) {
      ma.classList.add('alterada');
      ma.appendChild(document.createTextNode('Meta de hoje alterada para ' + fmt(m.recomendada) + '. '));
      const v = el('button', 'link', 'Voltar à recomendada'); v.onclick = voltarMetaRecomendada; ma.appendChild(v);
    } else {
      ma.textContent = 'A alteração vale só para hoje.';
    }

    // Registros do dia (para desfazer um toque errado)
    const doDia = estado.agua.filter((r) => r.dia === dia).sort((a, b) => (a.registrado_em < b.registrado_em ? 1 : -1));
    const total = doDia.reduce((t, r) => t + r.quantidade_ml, 0);
    $('h-parcial').textContent = fmt(total);
    $('h-qtd-registros').textContent = doDia.length ? '(' + doDia.length + ')' : '';
    const ul = $('lista-insercoes'); ul.innerHTML = '';
    if (!doDia.length) ul.appendChild(el('li', 'vazio', 'Nenhum registro hoje ainda.'));
    doDia.forEach((r) => {
      const li = el('li'); const d = el('div');
      d.appendChild(el('span', 'hora', horaDe(r.registrado_em))); d.appendChild(el('span', 'ml', fmt(r.quantidade_ml)));
      li.appendChild(d);
      const b = el('button', '', '✕'); b.setAttribute('aria-label', 'Apagar');
      b.onclick = () => {
        if (!confirm('Apagar ' + fmt(r.quantidade_ml) + ' das ' + horaDe(r.registrado_em) + '?')) return;
        remover('Agua', r.id); desenhar(); atualizarStatus(); avisar('Apagado'); sincronizar();
      };
      li.appendChild(b); ul.appendChild(li);
    });

    desenharTabelaMes();
  }

  // Tabela do mês: consumo de cada dia e quanto ficou acima/abaixo das metas
  function desenharTabelaMes() {
    const sel = $('mes-tabela');
    const atual = hoje().slice(0, 7);
    const meses = [];
    for (let mm = primeiroDia().slice(0, 7); mm <= atual; mm = somaDias(mm + '-28', 7).slice(0, 7)) meses.push(mm);
    if (!meses.length) meses.push(atual);
    const escolhido = meses.indexOf(sel.value) >= 0 ? sel.value : atual;
    if (sel.options.length !== meses.length) {
      sel.innerHTML = '';
      meses.slice().reverse().forEach((mm) => {
        const o = el('option', '', new Date(mm + '-15T12:00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '').replace(' de ', '/'));
        o.value = mm; sel.appendChild(o);
      });
    }
    sel.value = escolhido;
    const tb = $('tab-mes'); tb.innerHTML = '';
    const inicio = primeiroDia();
    let d = escolhido + '-01';
    let linhas = 0;
    for (; d.slice(0, 7) === escolhido && d <= hoje(); d = somaDias(d, 1)) {
      if (d < inicio) continue;
      const md = metasDoDia(d); const tot = totalDoDia(d);
      const tr = el('tr', d === hoje() ? 'hoje' : '');
      tr.appendChild(el('td', '', d.slice(8)));
      tr.appendChild(el('td', 't-' + { excelente: 'exc', bom: 'bom', ruim: 'ruim' }[situacao(tot, md)], fmt(tot)));
      [md.minima, md.recomendada].forEach((meta) => {
        const v = meta ? (tot / meta - 1) * 100 : 0;
        const td = el('td', 'var');
        td.appendChild(el('span', v >= 0 ? 'sobe' : 'desce', v >= 0 ? '▲ ' : '▼ '));
        td.appendChild(document.createTextNode(pctTxt(v)));
        tr.appendChild(td);
      });
      tb.appendChild(tr); linhas++;
    }
    if (!linhas) { const tr = el('tr'); const td = el('td', 'vazio', 'Sem registros neste mês.'); td.colSpan = 4; tr.appendChild(td); tb.appendChild(tr); }
  }
  $('mes-tabela').addEventListener('change', desenharTabelaMes);

  function adicionar(valor) {
    const ml = Math.round(Number(valor));
    if (!(ml > 0 && ml <= 5000)) { avisar('Digite uma quantidade entre 1 e 5000 ml'); return; }
    registrar('Agua', { id: novoId(), dia: hoje(), quantidade_ml: ml, registrado_em: new Date().toISOString() });
    desenhar(); atualizarStatus(); avisar('+' + fmt(ml)); sincronizar();
  }
  document.querySelectorAll('[data-ml]').forEach((b) => { b.onclick = () => adicionar(b.dataset.ml); });
  $('add-outro').onclick = () => { adicionar($('outro').value); $('outro').value = ''; };
  $('outro').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-outro').click(); });

  // Alterar a meta recomendada de hoje (dias que já passaram não mudam mais)
  function alterarMetaHoje() {
    const ml = Math.round(Number($('nova-meta').value));
    if (!(ml >= 500 && ml <= 10000)) { avisar('Digite uma meta entre 500 e 10000 ml'); $('nova-meta').focus(); return; }
    alteracoesDoDia(hoje()).forEach((x) => remover('Metas', x.id));
    registrar('Metas', { id: novoId(), modulo: 'agua', tipo: 'recomendada_dia', valor: ml, unidade: 'ml', valida_desde: hoje(), registrado_em: new Date().toISOString() });
    $('nova-meta').value = ''; $('nova-meta').blur();
    desenhar(); atualizarStatus(); avisar('Meta de hoje: ' + fmt(ml)); sincronizar();
  }
  function voltarMetaRecomendada() {
    alteracoesDoDia(hoje()).forEach((x) => remover('Metas', x.id));
    desenhar(); atualizarStatus(); avisar('Voltou para a meta recomendada'); sincronizar();
  }
  $('btn-nova-meta').onclick = alterarMetaHoje;
  $('nova-meta').addEventListener('keydown', (e) => { if (e.key === 'Enter') alterarMetaHoje(); });

  // ---------- Tela inicial ----------
  function desenharHome() {
    const m = metasDoDia(hoje()); const tot = totalDoDia(hoje());
    $('b-agua').textContent = Math.round(tot).toLocaleString('pt-BR') + ' / ' + fmt(m.recomendada);
    $('b-agua-barra').style.width = Math.min(100, m.recomendada ? (tot / m.recomendada) * 100 : 0) + '%';
    const a = adicionalPorTreino(hoje());
    $('b-treino').textContent = a.treinos.length ? a.minutos + ' min hoje' : 'nada hoje';
  }

  // ---------- Painel ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); return e; };

  function desenharRosca() {
    const dia = hoje();
    const m = metasDoDia(dia);
    const total = totalDoDia(dia);
    const sit = situacao(total, m);
    const pct = m.recomendada ? Math.round((total / m.recomendada) * 100) : 0;
    const C = 2 * Math.PI * 56;
    const arco = $('p-arco');
    arco.style.strokeDashoffset = C * (1 - Math.min(pct, 100) / 100);
    arco.setAttribute('class', 'arco ' + sit);
    // marquinha da meta mínima no anel
    const ang = (Math.min(m.minima / m.recomendada, 1) * 360);
    $('p-marca').setAttribute('transform', 'rotate(' + ang + ' 66 66)');
    $('p-pct').textContent = pct + '%';
    $('p-total').textContent = fmt(total);
    $('p-de').textContent = 'de ' + fmt(m.recomendada) + ' (recomendada)';
    const s = $('p-situacao'); s.innerHTML = ''; s.appendChild(chip(sit));
    $('p-min').textContent = fmt(m.minima);
    $('p-rec').textContent = fmt(m.recomendada);
    const falta = (sit === 'ruim' ? m.minima : m.recomendada) - total;
    $('p-falta').textContent = sit === 'excelente' ? 'Meta recomendada batida! 🎉'
      : 'Faltam ' + fmt(falta) + ' para a ' + (sit === 'ruim' ? 'mínima' : 'recomendada');
  }

  function desenharMes() {
    const dia = hoje();
    const ini = dia.slice(0, 8) + '01';
    const comeco = primeiroDia() > ini ? primeiroDia() : ini;
    let tot = 0, somaMin = 0, somaRec = 0, n = 0, dMin = 0, dRec = 0;
    for (let d = comeco; d <= dia; d = somaDias(d, 1)) {
      const md = metasDoDia(d); const t = totalDoDia(d);
      tot += t; somaMin += md.minima; somaRec += md.recomendada; n++;
      if (t >= md.minima) dMin++;
      if (t >= md.recomendada) dRec++;
    }
    const nomeMes = new Date(dia + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long' });
    $('m-titulo').textContent = 'Avaliação de ' + nomeMes;
    $('m-periodo').textContent = n + (n === 1 ? ' dia' : ' dias') + ' contados (de ' + diaCurto(comeco) + ' até hoje)';
    const s = $('m-situacao'); s.innerHTML = ''; s.appendChild(chip(situacao(tot, { minima: somaMin, recomendada: somaRec })));
    $('m-total').textContent = litros(tot);
    $('m-meta-min').textContent = litros(somaMin);
    $('m-meta-rec').textContent = litros(somaRec);
    $('m-dias-min').textContent = dMin + ' de ' + n;
    $('m-dias-rec').textContent = dRec + ' de ' + n;
    $('m-barra-min').style.width = (n ? (dMin / n) * 100 : 0) + '%';
    $('m-barra-rec').style.width = (n ? (dRec / n) * 100 : 0) + '%';
  }

  function desenharSemana() {
    const box = $('grafico-semana');
    const W = Math.max(280, box.clientWidth || 320), H = 220;
    const pad = { e: 36, d: 12, t: 14, b: 28 };
    const dias = [];
    for (let i = 6; i >= 0; i--) {
      const d = somaDias(hoje(), -i); const m = metasDoDia(d);
      dias.push({ dia: d, total: totalDoDia(d), minima: m.minima, recomendada: m.recomendada });
    }
    const maior = Math.max(...dias.map((d) => Math.max(d.total, d.recomendada)));
    const topo = Math.max(1000, Math.ceil((maior * 1.08) / 500) * 500);
    const x = (i) => pad.e + (i * (W - pad.e - pad.d)) / 6;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / topo);
    const g = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Consumo de água dos últimos 7 dias comparado com as metas mínima e recomendada' });

    // grade e eixo (em litros)
    const passo = topo <= 2000 ? 500 : topo <= 4000 ? 1000 : 1500;
    for (let v = 0; v <= topo; v += passo) {
      g.appendChild(svg('line', { x1: pad.e, x2: W - pad.d, y1: y(v), y2: y(v), class: v ? 'grade' : 'base' }));
      const t = svg('text', { x: pad.e - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'eixo' });
      t.textContent = (v / 1000).toLocaleString('pt-BR') + ' L'; g.appendChild(t);
    }
    dias.forEach((d, i) => {
      const t = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'eixo' + (i === 6 ? ' forte' : '') });
      t.textContent = i === 6 ? 'hoje' : semanaDe(d.dia); g.appendChild(t);
    });

    // área do consumo
    const pts = dias.map((d, i) => x(i) + ',' + y(d.total)).join(' ');
    g.appendChild(svg('polygon', { points: x(0) + ',' + y(0) + ' ' + pts + ' ' + x(6) + ',' + y(0), class: 'area' }));
    g.appendChild(svg('polyline', { points: pts, class: 'linha-consumo' }));
    // linhas das metas
    g.appendChild(svg('polyline', { points: dias.map((d, i) => x(i) + ',' + y(d.minima)).join(' '), class: 'linha-min' }));
    g.appendChild(svg('polyline', { points: dias.map((d, i) => x(i) + ',' + y(d.recomendada)).join(' '), class: 'linha-rec' }));
    dias.forEach((d, i) => g.appendChild(svg('circle', { cx: x(i), cy: y(d.total), r: 4, class: 'ponto' })));

    // camada de passar o dedo / mouse
    const guia = svg('line', { y1: pad.t, y2: H - pad.b, class: 'guia', visibility: 'hidden' });
    g.appendChild(guia);
    const dica = $('dica-semana');
    const alvo = svg('rect', { x: pad.e - 10, y: 0, width: W - pad.e - pad.d + 20, height: H, fill: 'transparent' });
    function mover(ev) {
      const r = g.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.max(0, Math.min(6, Math.round(((px - pad.e) / (W - pad.e - pad.d)) * 6)));
      const d = dias[i];
      guia.setAttribute('x1', x(i)); guia.setAttribute('x2', x(i)); guia.setAttribute('visibility', 'visible');
      dica.innerHTML = '';
      dica.appendChild(el('div', 'dica-dia', (i === 6 ? 'Hoje' : semanaDe(d.dia)) + ', ' + diaCurto(d.dia)));
      [['consumo', 'Consumo', d.total], ['rec', 'Recomendada', d.recomendada], ['min', 'Mínima', d.minima]].forEach(([c, n, v]) => {
        const l = el('div', 'dica-linha'); l.appendChild(el('span', 'amostra ' + c)); l.appendChild(el('span', '', n));
        l.appendChild(el('b', '', fmt(v))); dica.appendChild(l);
      });
      dica.appendChild(chip(situacao(d.total, d)));
      dica.classList.add('ver');
      const largura = dica.offsetWidth;
      dica.style.left = Math.max(0, Math.min(W - largura, x(i) + (i > 3 ? -largura - 12 : 12))) + 'px';
    }
    const esconder = () => { guia.setAttribute('visibility', 'hidden'); dica.classList.remove('ver'); };
    alvo.addEventListener('mousemove', mover);
    alvo.addEventListener('touchstart', mover, { passive: true });
    alvo.addEventListener('touchmove', mover, { passive: true });
    alvo.addEventListener('mouseleave', esconder);
    g.appendChild(alvo);

    box.querySelectorAll('svg').forEach((s) => s.remove());
    box.insertBefore(g, dica);
  }

  function desenharPainel() {
    $('aviso-perfil').classList.toggle('escondido', !!perfilNoDia(hoje()));
    desenharRosca(); desenharMes(); desenharSemana();
  }
  let redimTimer;
  window.addEventListener('resize', () => { clearTimeout(redimTimer); redimTimer = setTimeout(() => { if (secao === 'painel') desenharSemana(); }, 150); });

  // ---------- Backup por e-mail ----------
  // Junta todas as abas num único .csv (separado por ";" para abrir direto no Excel em português)
  // e envia para o e-mail da própria pessoa pelo Gmail dela. Sem Gmail (modo demo ou erro), baixa o arquivo.
  function montarCsv() {
    const cel = (v) => { const t = v === undefined || v === null ? '' : String(v); return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const linhas = ['ShapeUp - backup de ' + new Date().toLocaleString('pt-BR')];
    Object.keys(TABELAS).forEach((t) => {
      linhas.push('', '[' + t + ']', TABELAS[t].map(cel).join(';'));
      listaDe(t).forEach((i) => linhas.push(TABELAS[t].map((c) => cel(typeof i[c] === 'number' ? String(i[c]).replace('.', ',') : i[c])).join(';')));
    });
    return '\ufeff' + linhas.join('\r\n');
  }
  const nomeBackup = () => 'shapeup-backup-' + hoje() + '.csv';
  const b64 = (txt) => { const b = new TextEncoder().encode(txt); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };

  async function baixarBackup(motivo) {
    const arq = new File([montarCsv()], nomeBackup(), { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [arq] })) {
      try { await navigator.share({ files: [arq], title: 'Backup ShapeUp' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = el('a'); a.href = URL.createObjectURL(arq); a.download = arq.name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (motivo) avisar(motivo);
  }

  async function fazerBackup() {
    if (modoDemo) { baixarBackup('Modo demonstração: o arquivo foi baixado.'); return; }
    if (!navigator.onLine) { baixarBackup('Sem internet: o arquivo foi baixado.'); return; }
    if (!tokenValido() || !temEscopo('gmail.send')) {
      // pede ao Google a permissão de enviar e-mail (só na primeira vez) e volta para cá
      try { sessionStorage.setItem('shape-depois', 'backup'); } catch (e) { /* */ }
      irParaGoogle(false, ESCOPO_GMAIL);
      return;
    }
    const email = conta && conta.email;
    if (!email) { baixarBackup('Não achei seu e-mail: o arquivo foi baixado.'); return; }
    const info = $('backup-info'); info.textContent = 'Enviando backup para ' + email + '…';
    const sep = 'shapeup-' + novoId();
    const assunto = 'Backup ShapeUp - ' + new Date().toLocaleDateString('pt-BR');
    const mime = [
      'To: ' + email, 'Subject: =?UTF-8?B?' + b64(assunto) + '?=', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="' + sep + '"', '',
      '--' + sep, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      b64('Olá!\n\nSegue em anexo o backup de todos os seus dados do ShapeUp (treinos, água, perfil, metas e cadastros).\n' +
        'O arquivo abre no Excel ou no Google Planilhas.\n\nShapeUp'),
      '--' + sep, 'Content-Type: text/csv; charset=UTF-8; name="' + nomeBackup() + '"',
      'Content-Disposition: attachment; filename="' + nomeBackup() + '"', 'Content-Transfer-Encoding: base64', '',
      b64(montarCsv()).replace(/.{76}/g, '$&\r\n'), '--' + sep + '--', '',
    ].join('\r\n');
    try {
      await google('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
        body: { raw: b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
      info.textContent = 'Último backup enviado para ' + email + ' em ' + new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + '.';
      avisar('Backup enviado para o seu e-mail');
    } catch (e) {
      console.error(e);
      info.textContent = 'O Gmail recusou o envio (' + e.message + '). Baixei o arquivo no aparelho.';
      baixarBackup();
    }
  }
  $('btn-backup').onclick = fazerBackup;

  // ---------- Desenho geral ----------
  function desenhar() {
    if ($('tela-app').classList.contains('escondido')) return;
    if (secao === 'painel') desenharPainel();
    else if (secao === 'home') desenharHome();
    else if (secao === 'hidratacao') desenharHidratacao();
    else if (secao === 'treino') desenharTreinos();
    else if (secao === 'perfil') preencherPerfil();
    else if (CADASTROS[secao]) desenharCadastro();
  }

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
    // primeira vez, sem perfil: começa pelo Perfil
    if (!estado.perfil.length && !guardar.ler('shape-secao', null)) secao = 'perfil';
    irPara(secao); atualizarStatus(); sincronizar();
    // voltou do Google depois de pedir a permissão do backup?
    let depois = null;
    try { depois = sessionStorage.getItem('shape-depois'); sessionStorage.removeItem('shape-depois'); } catch (e) { /* */ }
    if (depois === 'backup') { irPara('perfil'); if (temEscopo('gmail.send')) fazerBackup(); else avisar('Backup cancelado: o envio de e-mail não foi permitido.'); }
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
      if (jaEntrou && ret.erro === 'access_denied') { abrirApp(); return; } // ex.: recusou a permissão do backup
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
