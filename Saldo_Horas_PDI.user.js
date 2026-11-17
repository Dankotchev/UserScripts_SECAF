// ==UserScript==
// @name         Saldo de Horas de Afastamento PDI
// @namespace    ddq.pdi.saldo
// @version      1.3.6
// @description  Calcula a quantidade de horas de afastamento utilizadas pelo código 09-027 e apresenta as horas restantes disponibilizadas.
// @author       Danilo D Quirino
// @match        *://w3.secaf.sda.ibge.gov.br/*
// @match        *://intranet.ibge.gov.br/*
// @run-at       document-idle
// @noframes
// @updateURL
// @downloadURL
// ==/UserScript==

(function () {
  const isApuracao =
    location.pathname.includes('SDA-SECAF/ui/afastamento/') ||
    location.href.includes('SDA-SECAF/ui/afastamento/');
  if (!isApuracao) return;
  'use strict';

  // ===============================
  // 🔧 PARÂMETROS INICIAIS
  // ===============================
  const DEFAULTS = {
    CODIGO: '09-027',
    HORAS_DISPONIVEIS: 22,
    pontoFacultativoComoFeriado: true
  };

  const STORAGE_KEY = 'ddq_pdi_config_v1';

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const cfg = JSON.parse(raw);
      return { ...DEFAULTS, ...cfg };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  let CONFIG = loadConfig();

  // ===============================
  // 🔎 AUXILIARES
  // ===============================
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const timeRegex = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/; // "HH:MM - HH:MM" (– — -)
  const titleSelector = 'span.fc-title.d-block'; // FullCalendar v3 (tema bootstrap)
  const timeSelector = 'span.fc-title';          // FullCalendar v3 (texto do horário fica no mesmo span)

  const fmtNum = (n) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const pad2 = (n) => String(n).padStart(2, '0');

  // NOVOS auxiliares p/ minutos
  const round = Math.round;
  const fmtMinPlain = (m) => `${m} min`;
  const horasToMin = (h) => round(h * 60);

  // ===============================
  // 🗓️ LER <info-mes> (MÊS/ANO, DIAS ÚTEIS, FERIADOS)
  // ===============================
  function parseMonthYearFromInfoMes(scope) {
    // 1) do href /ui/afastamento/YYYYMM/
    const a = scope.querySelector('.month-select a.month-select__icon[href*="/ui/afastamento/"]');
    const href = a?.getAttribute('href') || '';
    const m1 = href.match(/\/(\d{6})(?:\/|$)/);
    if (m1) {
      const y = Number(m1[1].slice(0, 4));
      const m = Number(m1[1].slice(4, 6)) - 1;
      if (!Number.isNaN(y) && !Number.isNaN(m)) return { y, m };
    }
    // 2) do select “Fevereiro 2026”
    const sel = scope.querySelector('.month-select__text');
    if (sel) {
      const opt =
        sel.selectedOptions?.[0]?.textContent ||
        sel.options?.[sel.selectedIndex || 0]?.textContent ||
        sel.textContent;
      if (opt) {
        const txt = norm(opt).toLowerCase();
        const meses = {
          janeiro: 0, jan: 0,
          fevereiro: 1, fev: 1,
          março: 2, marco: 2, mar: 2,
          abril: 3, abr: 3,
          maio: 4, mai: 4,
          junho: 5, jun: 5,
          julho: 6, jul: 6,
          agosto: 7, ago: 7,
          setembro: 8, set: 8,
          outubro: 9, out: 9,
          novembro: 10, nov: 10,
          dezembro: 11, dez: 11
        };
        const parts = txt.split(/\s+/);
        const mesNome = parts[0];
        const anoNum = Number(parts[1]);
        if (mesNome in meses && !Number.isNaN(anoNum)) {
          return { y: anoNum, m: meses[mesNome] };
        }
      }
    }
    // 3) fallback: mês do navegador
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  }

  function lerInfoMes(pfComoFeriado) {
    const infoMesEl = document.querySelector('info-mes') || document;
    const { y, m } = parseMonthYearFromInfoMes(infoMesEl);

    // dias úteis (se a página fornece)
    let diasUteisMes = null;
    const duEl = infoMesEl.querySelector('.work-days .work-days__number');
    if (duEl) {
      const n = parseInt(duEl.textContent, 10);
      if (!Number.isNaN(n)) diasUteisMes = n;
    }

    // feriados (dia + descrição)
    const feriados = [];
    const liEls = infoMesEl.querySelectorAll('.holidays ul li');
    liEls.forEach((li) => {
      const nEl = li.querySelector('.holidays__number');
      if (!nEl) return;
      const dia = parseInt(nEl.textContent, 10);
      if (Number.isNaN(dia)) return;
      const desc = norm(li.querySelector('.holidays__text')?.textContent || '');
      // toggle ponto facultativo
      if (!pfComoFeriado && /facultativo/i.test(desc)) return;
      feriados.push({ dia, desc });
    });

    const feriadoSet = new Set(feriados.map(f => f.dia));
    return { ano: y, mes: m, diasUteisMes, feriados, feriadoSet };
  }

  // ===============================
  // ⏱️ DATA DO EVENTO (FullCalendar v3 month view)
  // ===============================
  // Fallback: input[name="dataInicio"] (sidebar de Visualizar afastamento)
  function getDateFromInput() {
    const input =
      document.querySelector('input[name="dataInicio"].movimentacao__evento-pilula--dropdown-textarea') ||
      document.querySelector('input[name="dataInicio"]');
    const val = norm(input?.value || '');
    return val || null; // rótulo já pronto
  }

  // Data confiável por coluna:
  // 1) Usa thead da tabela do .fc-content-skeleton (td.fc-day-top[data-date]) na mesma coluna do evento (cellIndex).
  // 2) Fallback: usa .fc-bg table (irmã no .fc-row) na mesma coluna (td[data-date]).
  // 3) Fallback final: input[name="dataInicio"].
  function findDateForEvent(eventNode) {
    const eventTd = eventNode?.closest('td');
    if (eventTd) {
      const row = eventTd.parentElement;             // <tr> do tbody
      const table = row?.closest('table');           // tabela do .fc-content-skeleton
      const theadRow = table?.tHead?.rows?.[0];      // <thead><tr>...
      if (theadRow) {
        const colIndex = eventTd.cellIndex;
        const headerCell = theadRow.cells?.[colIndex];
        const headerDate = headerCell?.getAttribute?.('data-date');
        if (headerDate) {
          return { dataISO: headerDate, dataLabel: null };
        }
      }
      // fallback .fc-bg
      const fcRow = eventTd.closest('.fc-row');
      if (fcRow) {
        const bgTable = fcRow.querySelector('.fc-bg table');
        const bgRow = bgTable?.tBodies?.[0]?.rows?.[0];
        if (bgRow) {
          const colIndex = eventTd.cellIndex;
          const bgCell = bgRow.cells?.[colIndex];
          const bgDate = bgCell?.getAttribute?.('data-date');
          if (bgDate) {
            return { dataISO: bgDate, dataLabel: null };
          }
        }
      }
    }
    // fallback input
    const label = getDateFromInput();
    if (label) return { dataISO: null, dataLabel: label };

    return { dataISO: null, dataLabel: '(indefinido)' };
  }

  // ===============================
  // ⏱️ COLETA DE EVENTOS E CÁLCULOS
  // ===============================
  function coletarEventos(CODIGO) {
    const allTitleSpans = Array.from(document.querySelectorAll(titleSelector));
    const titleSpans = allTitleSpans.filter(el => norm(el.textContent) === CODIGO);
    const itens = [];

    for (const titleSpan of titleSpans) {
      // Tente pegar o <a class="fc-day-grid-event ..."> que contém o conteúdo
      const eventEl =
        titleSpan.closest('a.fc-day-grid-event') ||
        titleSpan.closest('.fc-event, .fc-daygrid-event, .fc-list-event, .fc-timegrid-event, a, div');

      const container = eventEl || titleSpan.parentElement;

      // Data do evento
      const dateInfo = findDateForEvent(eventEl || titleSpan);
      let dataLabel = dateInfo.dataLabel;
      if (!dataLabel && dateInfo.dataISO) {
        const [yy, mm, dd] = dateInfo.dataISO.split('-').map(Number);
        dataLabel = `${pad2(dd)}/${pad2(mm)}/${yy}`;
      }

      // Horário
      let timeText = null;
      const candidates = Array.from(container.querySelectorAll(timeSelector));
      for (const c of candidates) {
        const txt = norm(c.textContent);
        if (timeRegex.test(txt) && !txt.includes(CODIGO)) {
          timeText = txt;
          break;
        }
      }
      if (!timeText) {
        let el = titleSpan.parentElement;
        for (let i = 0; i < 3 && el && !timeText; i++, el = el.parentElement) {
          const more = Array.from(el.querySelectorAll(timeSelector));
          for (const c of more) {
            const txt = norm(c.textContent);
            if (timeRegex.test(txt) && !txt.includes(CODIGO)) {
              timeText = txt;
              break;
            }
          }
        }
      }

      if (timeText) {
        const m = timeText.match(timeRegex);
        const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
        let start = sh * 60 + sm;
        let end = eh * 60 + em;
        if (end < start) end += 24 * 60; // virada
        itens.push({
          titulo: CODIGO,
          dataISO: dateInfo.dataISO || null,
          dataLabel: dataLabel || '(indefinido)',
          horario: timeText,
          minutos: end - start
        });
      } else {
        itens.push({
          titulo: CODIGO,
          dataISO: dateInfo.dataISO || null,
          dataLabel: dataLabel || '(indefinido)',
          horario: null,
          minutos: 0,
          aviso: 'Horário não encontrado'
        });
      }
    }

    return { allTitleSpans, itens };
  }

  function existeLancamentoHoje(CODIGO) {
    const allTitleSpans = Array.from(document.querySelectorAll(titleSelector));
    const titleSpans = allTitleSpans.filter(el => norm(el.textContent) === CODIGO);

    const hoje = new Date();
    const y = hoje.getFullYear();
    const m = hoje.getMonth();
    const d = hoje.getDate();
    const hojeISO = `${y}-${pad2(m + 1)}-${pad2(d)}`;

    for (const span of titleSpans) {
      const eventEl =
        span.closest('a.fc-day-grid-event') ||
        span.closest('.fc-event, .fc-daygrid-event, .fc-list-event, .fc-timegrid-event, a, div');
      const dateInfo = findDateForEvent(eventEl || span);
      if (dateInfo.dataISO === hojeISO) return true;

      // Se caiu via label (ex.: "26/02/2026"), tenta comparar
      if (!dateInfo.dataISO && dateInfo.dataLabel) {
        const m2 = dateInfo.dataLabel.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m2) {
          const dd = Number(m2[1]), mm = Number(m2[2]) - 1, yy = Number(m2[3]);
          if (yy === y && mm === m && dd === d) return true;
        }
      }
    }
    return false;
  }

  function diasUteisRestantes(infoMes, haLancamentoHoje) {
    const hoje = new Date();
    const y = infoMes.ano;
    const m = infoMes.mes;
    const ultimoDia = new Date(y, m + 1, 0).getDate();

    let considerarHoje = false;
    let inicio = 1;

    if (hoje.getFullYear() === y && hoje.getMonth() === m) {
      inicio = hoje.getDate();
      const dowHoje = hoje.getDay(); // 0 Dom, 6 Sáb
      const ehFds = (dowHoje === 0 || dowHoje === 6);
      const ehFeriado = infoMes.feriadoSet.has(inicio);
      considerarHoje = (!ehFds && !ehFeriado && !haLancamentoHoje);
    }

    let dias = 0;
    if (considerarHoje) dias++;

    const startDia = (hoje.getFullYear() === y && hoje.getMonth() === m) ? (inicio + 1) : inicio;
    for (let dia = startDia; dia <= ultimoDia; dia++) {
      const data = new Date(y, m, dia);
      const dow = data.getDay();
      const ehFds = (dow === 0 || dow === 6);
      if (ehFds) continue;
      if (infoMes.feriadoSet.has(dia)) continue;
      dias++;
    }
    return dias;
  }

  function calcularTudo() {
    const { CODIGO, HORAS_DISPONIVEIS, pontoFacultativoComoFeriado } = CONFIG;

    const info = lerInfoMes(pontoFacultativoComoFeriado);
    const { itens } = coletarEventos(CODIGO);

    const totalMin = itens.reduce((a, b) => a + b.minutos, 0);
    const horasAcumuladas = totalMin / 60;

    const dispMin = HORAS_DISPONIVEIS * 60;
    const horasRestantesMin = Math.max(0, dispMin - totalMin);
    const horasRestantes = horasRestantesMin / 60;

    const haLancHoje = existeLancamentoHoje(CODIGO);
    const uteisRestantes = diasUteisRestantes(info, haLancHoje);
    const porDiaHoras = uteisRestantes > 0 ? (horasRestantesMin / uteisRestantes) / 60 : 0;
    const porDiaMin = uteisRestantes > 0 ? Math.round(horasRestantesMin / uteisRestantes) : 0;

    const usoPct = Math.min(100, Math.round(((dispMin - horasRestantesMin) / dispMin) * 100));

    const feriadosRestantes = (() => {
      const hoje = new Date();
      if (hoje.getFullYear() !== info.ano || hoje.getMonth() !== info.mes) return info.feriados;
      return info.feriados.filter(f => f.dia >= hoje.getDate());
    })();

    return {
      infoMes: info,
      itens,
      saldo: {
        horasDisponiveis: HORAS_DISPONIVEIS,
        horasAcumuladas,
        horasRestantes,
        horasRestantesMin,
        uteisRestantes,
        porDiaHoras,
        porDiaMin,
        usoPct,
        feriadosRestantes
      }
    };
  }

  // ===============================
  // 🖼️ PAINEL
  // ===============================
  const HOST_ID = 'ddq-pdi-panel-host';
  const LAUNCHER_ID = 'ddq-pdi-launcher';

  function ensureLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;

    const btn = document.createElement('button');
    btn.id = LAUNCHER_ID;
    Object.assign(btn.style, {
      position: 'fixed',
      zIndex: 2147483647,
      bottom: '18px',
      right: '18px',
      padding: '10px 12px',
      borderRadius: '999px',
      border: '1px solid #274060',
      background: '#133B5C',
      color: '#EAF6FF',
      font: '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
      cursor: 'pointer',
      boxShadow: '0 6px 16px rgba(0,0,0,.25)'
    });
    btn.textContent = 'PDI';
    btn.title = 'Abrir painel de PDI (Ctrl+Alt+M)';
    btn.addEventListener('click', () => openPanel());
    document.body.appendChild(btn);

    // Ajuste mínimo de botão por tema
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const applyBtnTheme = () => {
      if (mq.matches) {
        btn.style.border = '1px solid #274060';
        btn.style.background = '#133B5C';
        btn.style.color = '#EAF6FF';
      } else {
        btn.style.border = '1px solid #cfd8e3';
        btn.style.background = '#ffffff';
        btn.style.color = '#102a43';
      }
    };
    applyBtnTheme();
    mq.addEventListener?.('change', applyBtnTheme);
  }

  function closePanel() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();
  }

  function openPanel() {
    closePanel();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.zIndex = 2147483647;
    host.style.bottom = '24px';
    host.style.right = '24px';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      /* Habilita awareness de tema para controles nativos no Shadow DOM */
      :host, .panel { color-scheme: light dark; }

      /* --------- Tema CLARO (base) --------- */
      .panel {
        width: min(520px, 92vw);
        background: #ffffff;
        color: #0f172a; /* slate-900 */
        border: 1px solid #e2e8f0; /* slate-200 */
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,.12);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        animation: pop .2s ease-out;
      }
      @keyframes pop { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1); } }
      .hdr {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 14px; background:#f8fafc; border-bottom:1px solid #e2e8f0;
      }
      .ttl { font-weight:700; font-size:15px; letter-spacing:.2px; display:flex; align-items:center; gap:8px; }
      .badge { background:#e0f2fe; color:#075985; padding:2px 8px; border-radius:999px; font-size:12px; }
      .xbtn { border:none; background:transparent; color:#475569; font-size:18px; cursor:pointer; padding:4px 8px; }
      .xbtn:hover { color:#0f172a; }
      .cnt { padding:14px; display:grid; gap:12px; }
      .row { display:grid; grid-template-columns: 1fr auto; gap:12px; align-items:center; }
      .kpi { display:flex; gap:12px; flex-wrap:wrap; }
      .chip { background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:10px 12px; min-width:120px; }
      .chip .h { font-size:12px; color:#64748b; margin-bottom:4px; }
      .chip .v { font-weight:700; font-size:15px; color:#0f172a; }
      .progress { height:10px; background:#f1f5f9; border-radius:999px; overflow:hidden; border:1px solid #e2e8f0; }
      .bar { height:100%; background: linear-gradient(90deg,#3B82F6,#22D3EE); width:0%; transition: width .2s ease; }
      .lst { max-height: 200px; overflow:auto; border:1px solid #e2e8f0; border-radius:10px; background:#ffffff; }
      table { width:100%; border-collapse: collapse; font-size:13px; }
      th, td { padding:8px 10px; border-bottom:1px solid #e2e8f0; color:#0f172a; }
      th { position:sticky; top:0; background:#f8fafc; color:#334155; text-align:left; }
      tr:last-child td { border-bottom:none; }
      .ftr { display:flex; gap:8px; justify-content:flex-end; padding:12px 14px; background:#f8fafc; border-top:1px solid #e2e8f0; }
      .btn {
        appearance:none; border:1px solid #cbd5e1; background:#ffffff; color:#0f172a;
        border-radius:8px; padding:8px 12px; cursor:pointer; font-weight:600; font-size:13px;
      }
      .btn:hover { background:#f1f5f9; }
      .btn.p { background:#2563EB; border-color:#2563EB; color:#ffffff; }
      .btn.p:hover { background:#1D4ED8; }
      .muted { color:#64748b; font-size:12px; }
      .ok { color:#16a34a; }
      .warn { color:#d97706; }
      .err { color:#dc2626; }
      .dragger { cursor: move; }
      .small { font-size:12px; }
      .tag { display:inline-block; padding:2px 6px; border:1px solid #cbd5e1; border-radius:999px; margin-right:6px; color:#334155; }
      .toggle { display:flex; align-items:center; gap:10px; }
      .switch { position:relative; display:inline-block; width:46px; height:24px; }
      .switch input { opacity:0; width:0; height:0; }
      .slider {
        position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0;
        background:#e2e8f0; transition:.2s; border-radius:24px; border:1px solid #cbd5e1;
      }
      .slider:before { position:absolute; content:""; height:18px; width:18px; left:3px; bottom:2.5px; background:white; transition:.2s; border-radius:50%; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
      input:checked + .slider { background:#2563EB; border-color:#2563EB; }
      input:checked + .slider:before { transform: translateX(22px); }

      /* --------- Tema ESCURO (override) --------- */
      @media (prefers-color-scheme: dark) {
        .panel {
          background: #101418;
          color: #EBF2FA;
          border: 1px solid #2A2F36;
          box-shadow: 0 20px 50px rgba(0,0,0,.4);
        }
        .hdr { background:#0B0F13; border-bottom:1px solid #1E242B; }
        .badge { background:#1C2938; color:#9CD1FF; }
        .xbtn { color:#97A5B3; }
        .xbtn:hover { color:#D7DFE7; }
        .chip { background:#16202B; border:1px solid #233041; }
        .chip .h { color:#93A6B8; }
        .chip .v { color:#F2F6FA; }
        .progress { background:#1B272F; border:1px solid #233041; }
        .lst { border:1px solid #1E2A36; background:#101418; }
        th, td { border-bottom:1px solid #1C2733; color:#EBF2FA; }
        th { background:#0E141A; color:#9FB1C2; }
        .ftr { background:#0B0F13; border-top:1px solid #1E242B; }
        .btn { border:1px solid #2A3949; background:#15202B; color:#DDE7F0; }
        .btn:hover { background:#1A2733; }
        .btn.p { background:#2563EB; border-color:#2563EB; color:#fff; }
        .btn.p:hover { background:#1D4ED8; }
        .muted { color:#9FB1C2; }
        .ok { color:#22C55E; }
        .warn { color:#F59E0B; }
        .err { color:#EF4444; }
        .tag { border:1px solid #2A3949; color:#BFD7EA; }
        .slider { background:#334155; border:1px solid #233041; }
        .slider:before { background:#ffffff; box-shadow: none; }
      }
    `;
    shadow.appendChild(style);

    function render() {
      const { CODIGO, HORAS_DISPONIVEIS, pontoFacultativoComoFeriado } = CONFIG;
      const calc = calcularTudo();
      const { infoMes, itens, saldo } = calc;
      const {
        horasDisponiveis, horasAcumuladas, horasRestantes, horasRestantesMin,
        uteisRestantes, porDiaHoras, porDiaMin, usoPct, feriadosRestantes
      } = saldo;

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <div class="hdr dragger" title="Arraste para mover">
          <div class="ttl">Horas de PDI — <span class="badge">${CODIGO}</span></div>
          <button class="xbtn" aria-label="Fechar" title="Fechar">✕</button>
        </div>

        <div class="cnt">
          <div class="kpi">
            <div class="chip">
              <div class="h">Horas disponíveis</div>
              <div class="v">${fmtNum(horasDisponiveis)} h</div>
            </div>
            <div class="chip">
              <div class="h">Total acumulado</div>
              <div class="v">${fmtNum(horasAcumuladas)} h</div>
            </div>
            <div class="chip">
              <div class="h">Horas restantes</div>
              <div class="v ${horasRestantesMin === 0 ? 'ok' : 'warn'}">
                ${fmtNum(horasRestantes)} h <span class="muted">(${fmtMinPlain(horasRestantesMin)})</span>
              </div>
            </div>
            <div class="chip">
              <div class="h">Dias úteis restantes (exclui feriados)</div>
              <div class="v">${uteisRestantes}</div>
            </div>
            <div class="chip">
              <div class="h">Por dia (igual)</div>
              <div class="v">
                ${fmtNum(porDiaHoras)} h/dia <span class="muted">(${fmtMinPlain(porDiaMin)})</span>
              </div>
            </div>
          </div>

          <div class="small">
            <span class="tag">Mês: ${pad2(infoMes.mes + 1)}/${infoMes.ano}</span>
            ${infoMes.diasUteisMes != null ? `<span class="tag">Dias úteis no mês: ${infoMes.diasUteisMes}</span>` : ''}
            <span class="tag">Feriados no mês: ${infoMes.feriados.length}</span>
            <span class="tag">Feriados restantes: ${feriadosRestantes.length}</span>
          </div>

          <div class="row" style="margin-top:4px;">
            <div class="toggle">
              <label class="switch" title="Quando ligado, ponto facultativo é tratado como feriado">
                <input type="checkbox" id="pfToggle" ${pontoFacultativoComoFeriado ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
              <div class="muted">Contar <strong>ponto facultativo</strong> como feriado</div>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn" id="refreshBtn" title="Recalcular (revarrer a página)">Atualizar</button>
            </div>
          </div>

          <div style="margin-top:6px;">
            <div class="row" style="margin-bottom:6px;">
              <div class="muted">Uso das horas</div>
              <div class="muted">${usoPct}%</div>
            </div>
            <div class="progress"><div class="bar" style="width:${usoPct}%;"></div></div>
          </div>

          <div class="lst" aria-label="Lançamentos" style="margin-top:6px;">
            <table>
              <thead>
                <tr>
                  <th style="width:140px;">Data</th>
                  <th>Horário</th>
                  <th style="width:88px;">Min</th>
                </tr>
              </thead>
              <tbody>
                ${
                  itens.length
                    ? itens.map((it) => `
                        <tr>
                          <td>${it.dataLabel}</td>
                          <td>${it.horario ? it.horario : '<span class="muted">(não encontrado)</span>'}</td>
                          <td>${it.minutos}</td>
                        </tr>
                      `).join('')
                    : `<tr><td colspan="3" class="muted">Nenhum evento "${CODIGO}" encontrado nesta visão.</td></tr>`
                }
              </tbody>
            </table>
          </div>

          ${
            feriadosRestantes.length
              ? `
                <div class="small muted">
                  <strong>Feriados restantes:</strong>
                  ${feriadosRestantes.map(f => `${pad2(f.dia)}/${pad2(infoMes.mes+1)}/${infoMes.ano}: ${f.desc}`).join(' • ')}
                </div>
              `
              : ''
          }

          <div class="muted" style="margin-top:4px;">
            ${
              uteisRestantes > 0
                ? `Distribua <strong>${fmtNum(porDiaHoras)}h/dia</strong> <span class="muted">(${fmtMinPlain(porDiaMin)})</span> nos <strong>${uteisRestantes}</strong> dias úteis restantes (excluindo feriados listados${CONFIG.pontoFacultativoComoFeriado ? ' e pontos facultativos' : ''}).`
                : (horasRestantesMin === 0
                    ? '<span class="ok">Saldo utilizado por completo neste mês.</span>'
                    : '<span class="err">Sem dias úteis restantes. Avalie ajustes manuais.</span>')
            }
          </div>
        </div>

        <div class="ftr">
          <button class="btn p" id="closeBtn">Fechar</button>
        </div>
      `;
      shadow.innerHTML = '';
      shadow.appendChild(style);
      shadow.appendChild(panel);

      // ações
      const qs = (sel) => shadow.querySelector(sel);
      const close = () => closePanel();
      qs('.xbtn').addEventListener('click', close);
      qs('#closeBtn').addEventListener('click', close);

      qs('#pfToggle').addEventListener('change', (e) => {
        CONFIG.pontoFacultativoComoFeriado = !!e.target.checked;
        saveConfig(CONFIG);
        render();
      });
      qs('#refreshBtn').addEventListener('click', () => render());

      // draggable
      (function makeDraggable() {
        const header = shadow.querySelector('.dragger');
        let startX = 0, startY = 0, sx = 0, sy = 0, dragging = false;
        header.addEventListener('mousedown', start);
        header.addEventListener('touchstart', start, { passive: true });
        function start(e) {
          dragging = true;
          const pt = ('touches' in e) ? e.touches[0] : e;
          startX = pt.clientX; startY = pt.clientY;
          const rect = host.getBoundingClientRect(); sx = rect.left; sy = rect.top;
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', end);
          document.addEventListener('touchmove', move, { passive: false });
          document.addEventListener('touchend', end);
        }
        function move(e) {
          if (!dragging) return;
          const pt = ('touches' in e) ? e.touches[0] : e;
          if ('touches' in e) e.preventDefault();
          const dx = pt.clientX - startX; const dy = pt.clientY - startY;
          host.style.left = `${Math.max(8, sx + dx)}px`;
          host.style.top = `${Math.max(8, sy + dy)}px`;
          host.style.right = 'auto';
          host.style.bottom = 'auto';
        }
        function end() {
          dragging = false;
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', end);
          document.removeEventListener('touchmove', move);
          document.removeEventListener('touchend', end);
        }
      })();
    }

    render();
  }

  // Hotkey para abrir/fechar (Ctrl+Alt+P)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key.toLowerCase?.() === 'p')) {
      const opened = document.getElementById(HOST_ID);
      if (opened) {
        opened.remove();
      } else {
        openPanel();
      }
    }
  });

  ensureLauncher();
  const mo = new MutationObserver(() => ensureLauncher());
  mo.observe(document.body, { childList: true, subtree: true });
})();