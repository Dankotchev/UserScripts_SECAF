// ==UserScript==
// @name         PGD - 64 Horas presenciais
// @namespace    ddq.pgd.meta64
// @version      1.2.2
// @description  Controle de horas PGD com objetivo mensal de 64h
// @author       Danilo D. Quirino
// @match        *://w3.secaf.sda.ibge.gov.br/*
// @match        *://intranet.ibge.gov.br/*
// @run-at       document-idle
// @noframes
// @updateURL    https://github.com/Dankotchev/UserScripts_SECAF/raw/refs/heads/main/Horas_PGD.user.js
// @downloadURL  https://github.com/Dankotchev/UserScripts_SECAF/raw/refs/heads/main/Horas_PGD.user.js
// ==/UserScript==
(async function() {
    const isApuracao = location.pathname.includes('/SDA-SECAF/ui/apuracao/') || location.href.includes('/SDA-SECAF/ui/apuracao/');
    if (!isApuracao) return;
    await aguardarFeriados();
    'use strict';
    const HOST_ID = 'ddq-pgd-host';
    const BTN_ID = 'ddq-pgd-launcher';
    const STORAGE_KEY = 'ddq-pgd-config';
    const {
        ANO,
        MES
    } = getMesApuracao();
    const FERIADOS = getFeriados();
    const DIAS_FERIADOS = new Set(FERIADOS.map(f => Number(f.dia)));
    const pad = n => String(n)
        .padStart(2, '0');
    const fmtHM = minutos => {
        const sinal = minutos < 0 ? '-' : '';
        minutos = Math.abs(minutos);
        const h = Math.floor(minutos / 60);
        const m = minutos % 60;
        return `${sinal}${h}h${pad(m)}m`;
    };
    const CODIGOS_ZERO_HORAS = ["0270", "0221"];
    const CONFIG_PADRAO = {
        diasSemana: [2, 3], // terça e quarta
        metaHoras: 64
    };
    const META_MINUTOS = getMetaMinutos();
    // Configurações do usuário
    function getConfig() {
        try {
            return {
                ...CONFIG_PADRAO,
                ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
            };
        } catch {
            return CONFIG_PADRAO;
        }
    }

    function setConfig(cfg) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    }

    function getMetaMinutos() {
        return getConfig()
            .metaHoras * 60;
    }
    ////
    function getMesApuracao() {
        const select = document.querySelector('select.month-select__text[name="mes"]');
        const texto = select?.selectedOptions?.[0]?.textContent?.trim();
        if (!texto) return;
        const [nomeMes, anoStr] = texto.split(/\s+/);
        const meses = {
            janeiro: 0,
            fevereiro: 1,
            março: 2,
            marco: 2,
            abril: 3,
            maio: 4,
            junho: 5,
            julho: 6,
            agosto: 7,
            setembro: 8,
            outubro: 9,
            novembro: 10,
            dezembro: 11
        };
        return {
            ANO: Number(anoStr),
            MES: meses[nomeMes.toLowerCase()]
        };
    }

    function getFeriados() {
        const feriados = [];
        document.querySelectorAll('.holidays .row')
            .forEach(li => {
                const dia = li.querySelector('.holidays__number')
                    ?.textContent?.trim();
                const desc = li.querySelector('.holidays__text')
                    ?.textContent?.trim();
                if (true) {
                    feriados.push({
                        dia,
                        descricao: desc,
                        minutos: 480
                    });
                }
            });
        return feriados.filter(f => {
            const data = new Date(ANO, MES, f.dia);
            const dow = data.getDay();
            return dow !== 0 && dow !== 6;
        })
    }

    function parseCodigo(row) {
        return [...row.querySelectorAll('.movimentacao__evento-pilula')].map(pilula => ({
                codigo: pilula.querySelector('.px-2')
                    ?.textContent.trim() ?? '',
                descricao: pilula.querySelector('.pr-2')
                    ?.textContent.trim() ?? ''
            }))
            .filter(x => x.codigo);
    }

    function parseDia(row) {
        const h2 = row.querySelector('th h2');
        const h3 = row.querySelector('th h3');
        if (!h2 || !h3) return null;
        return {
            dia: Number(h2.textContent.trim()),
            mesTxt: h3.textContent.trim()
        };
    }

    function parseHorasDia(row) {
        const spans = [...row.querySelectorAll('.movimentacao__horario-tempo')].map(x => x.textContent.trim());
        const hhmm = spans.findLast(s => /^\d{2}h\d{2}m$/i.test(s));
        if (!hhmm) return null;
        const m = hhmm.match(/(\d+)h(\d+)m/i);
        return Number(m[1]) * 60 + Number(m[2]);
    }

    function coletarDados() {
        const dias = [];
        document.querySelectorAll('tr.apuracao-row')
            .forEach(row => {
                const diaInfo = parseDia(row);
                if (!diaInfo) return;
                const horas = parseHorasDia(row);
                const codigos = parseCodigo(row);
                if (horas !== null) {
                    dias.push({
                        dia: diaInfo.dia,
                        data: `${pad(diaInfo.dia)}/${pad(MES + 1)}`,
                        minutos: horas,
                        codigos
                    });
                }
                if (horas <= 0 && codigos.some(c => CODIGOS_ZERO_HORAS.includes(c.codigo))) {
                    const data = new Date(ANO, MES, diaInfo.dia);
                    const weekDay = data.getDay();
                    if (weekDay > 0 && weekDay < 6) {
                        dias.push({
                            dia: diaInfo.dia,
                            data: `${pad(diaInfo.dia)}/${pad(MES + 1)}`,
                            minutos: 480,
                            codigos
                        });
                    }
                }
            });
        for (const feriado of FERIADOS) {
            const existe = dias.some(x => x.dia === feriado.dia);
            if (!existe) {
                dias.push({
                    dia: feriado.dia,
                    data: `${pad(feriado.dia)}/${pad(MES + 1)}`,
                    minutos: 480,
                    codigos: [{
                        codigo: '',
                        descricao: feriado.descricao
                    }]
                });
            }
        }
        dias.sort((a, b) => a.dia - b.dia);
        const totalMinutos = dias.reduce((s, d) => s + d.minutos, 0);
        return {
            dias,
            totalMinutos
        };
    }

    function diasUteisRestantes() {
        const hoje = new Date();
        const ultimoDia = new Date(ANO, MES + 1, 0)
            .getDate();
        let total = 0;
        for (let dia = hoje.getDate() + 1; dia <= ultimoDia; dia++) {
            const d = new Date(ANO, MES, dia);
            const dow = d.getDay();
            if (dow === 0 || dow === 6) continue;
            if (DIAS_FERIADOS.has(dia)) continue;
            total++;
        }
        return total;
    }

    function proximoDiaMeta(totalMinutos) {
        if (totalMinutos >= META_MINUTOS) {
            return 'Meta já cumprida';
        }
        const config = getConfig();
        const diasPermitidos = new Set(config.diasSemana);
        let acumulado = totalMinutos;
        const hoje = new Date();
        const ultimoDia = new Date(ANO, MES + 1, 0)
            .getDate();
        for (let dia = hoje.getDate() + 1; dia <= ultimoDia; dia++) {
            const data = new Date(ANO, MES, dia);
            const dow = data.getDay();
            if (DIAS_FERIADOS.has(dia)) {
                acumulado += 480;
            } else if (diasPermitidos.has(dow)) {
                acumulado += 480;
            }
            if (acumulado >= META_MINUTOS) {
                return `${pad(dia)}/${pad(MES + 1)}`;
            }
        }
        return 'Não atinge neste mês';
    }
    async function aguardarFeriados(timeout = 2000) {
        const inicio = Date.now();
        while (Date.now() - inicio < timeout) {
            const rows = document.querySelectorAll('.holidays .row');
            if (rows.length > 0) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        console.warn('PGD: seção de feriados não encontrada.');
    }

    function ensureButton() {
        if (document.getElementById(BTN_ID)) return;
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.textContent = 'PGD';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '12px',
            right: '12px',
            zIndex: 999999,
            border: 'none',
            borderRadius: '999px',
            background: '#133B5C',
            color: '#fff',
            padding: '10px 18px',
            fontWeight: '700',
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(0,0,0,.3)'
        });
        btn.onclick = togglePanel;
        document.body.appendChild(btn);
    }

    function closePanel() {
        document.getElementById(HOST_ID)
            ?.remove();
    }

    function togglePanel() {
        const panel = document.getElementById(HOST_ID);
        if (panel) {
            panel.remove();
            return;
        }
        abrirPanel();
    }

    function abrirPanel() {
        const dados = coletarDados();
        const horasFaltantes = Math.max(0, META_MINUTOS - dados.totalMinutos);
        const progresso = Math.min(100,
            (dados.totalMinutos / META_MINUTOS) * 100);
        const diasRest = diasUteisRestantes();
        const dias8h = Math.ceil(horasFaltantes / 480);
        const projecao = proximoDiaMeta(dados.totalMinutos);
        const host = document.createElement('div');
        host.id = HOST_ID;
        Object.assign(host.style, {
            position: 'fixed',
            right: '20px',
            bottom: '60px',
            width: '580px',
            maxHeight: '600px',
            zIndex: 99999999
        });
        const shadow = host.attachShadow({
            mode: 'open'
        });
        shadow.innerHTML = `<style>${render_css({progresso})}</style>
        ${renderPanelHtml({dados, progresso, horasFaltantes, dias8h, projecao, diasRest})}`
        document.body.appendChild(host);
        shadow.querySelectorAll('.dia-btn')
            .forEach(btn => {
                btn.addEventListener('click', () => {
                    const dia = Number(btn.dataset.dia);
                    const config = getConfig();
                    let dias = [...config.diasSemana];
                    if (dias.includes(dia)) {
                        dias = dias.filter(x => x !== dia);
                    } else {
                        dias.push(dia);
                    }
                    // impede ficar sem nenhum dia
                    if (!dias.length) {
                        dias = [dia];
                    }
                    setConfig({
                        ...config,
                        diasSemana: dias.sort()
                    });
                    btn.classList.toggle('ativo');
                    closePanel();
                    abrirPanel();
                });
            });
        // Fechar painel
        shadow.querySelector('.close')
            .addEventListener('click', closePanel);
        shadow.querySelector('#editar-meta')
            .addEventListener('click', () => {
                const config = getConfig();
                const valor = prompt('Informe a carga horária mensal desejada:', config.metaHoras);
                if (valor === null) {
                    return;
                }
                const horas = Number(valor);
                if (!Number.isInteger(horas) || horas < 1 || horas > 200) {
                    alert('Informe uma quantidade válida de horas entre 1 e 200.');
                    return;
                }
                const confirmar = confirm(`Deseja alterar a meta mensal para ${horas} horas?\n\n` +
                    'Utilize esta opção apenas se sua carga horária mensal for diferente da padrão de 64 horas.\n' +
                    'Feriados e pontos facultativos já são considerados automaticamente.');
                if (!confirmar) {
                    return;
                }
                setConfig({
                    ...config,
                    metaHoras: horas
                });
                location.reload();
            });
        // Drag and drop
        const drag = shadow.getElementById('drag');
        let movendo = false;
        let startX = 0;
        let startY = 0;
        let offsetX = 0;
        let offsetY = 0;
        drag.addEventListener('mousedown', e => {
            movendo = true;
            const rect = host.getBoundingClientRect();
            offsetX = rect.left;
            offsetY = rect.top;
            startX = e.clientX;
            startY = e.clientY;
            host.style.left = `${offsetX}px`;
            host.style.top = `${offsetY}px`;
            host.style.right = 'auto';
            host.style.bottom = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!movendo) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            host.style.left = `${offsetX + dx}px`;
            host.style.top = `${offsetY + dy}px`;
        });
        document.addEventListener('mouseup', () => {
            movendo = false;
        });
    }

    function init() {
        ensureButton();
    }
    // Recria botão caso a SPA recarregue conteúdo
    const observer = new MutationObserver(() => {
        ensureButton();
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function render_css({
        progresso
    }) {
        return `
* {
  box-sizing: border-box;
  font-family: Segoe UI, Arial;
}
.panel {
  background: #101418;
  color: #fff;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #233041;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.45);
}
.header {
  padding: 12px 16px;
  cursor: move;
  background: #0a0f14;
  font-weight: 700;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-title{
    display:flex;
    align-items:center;
    gap:16px;
}
.edit-meta{
    display:flex;
    align-items:center;
    justify-content:center;
    margin-left:6px;
    border:none;
    background:transparent;
    color:#9fb1c2;
    cursor:pointer;
    padding:4px;
    border-radius:4px;
    transition:.2s;
}
.edit-meta:hover{
    color:#4fa3ff;
    background:rgba(79,163,255,.1);
}

.close {
  cursor: pointer;
  font-size: 20px;
}
.content {
  padding: 14px;
}
.progress {
  height: 12px;
  background: #22303b;
  border-radius: 999px;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #22d3ee);
  width:${progresso}%;
}
.cards{
  margin-top:12px;
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:8px;
}
.card {
  background: #16202b;
  padding: 8px;
  border-radius: 8px;
}
.t {
  font-size: 12px;
  color: #9fb1c2;
}
.v {
  font-size: 14px;
  font-weight: 600;
  margin-top: 3px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 15px;
  font-size: 12px;
}
th,
td {
  padding: 8px;
  border-bottom: 1px solid #243241;
  text-align: left;
}
th {
  background: #0a0f14;
  position: sticky;
  top: 0;
}
.tbl {
  max-height: 320px;
  overflow: auto;
  margin-top: 10px;
}
.card-semana{
    margin-top:8px;
}
.dias-semana {
  display:flex;
  justify-content:center;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
  margin-top:10px;
}
.dia-btn {
  width: 100px;
  height: 30px;
  border-radius: 12px;
  border: 1px solid #324456;
  background: #16202b;
  color: #9fb1c2;
  cursor: pointer;
  font-weight: 600;
  transition: 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.dia-btn:hover {
  border-color: #4fa3ff;
}
.dia-btn.ativo {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
  box-shadow: 0 0 10px rgba(37, 99, 235, 0.5);
}
        `
    }

    function renderPanelHtml({
        dados,
        progresso,
        horasFaltantes,
        dias8h,
        projecao,
        diasRest
    }) {
        return `
<div class="panel">
  <div class="header" id="drag">
    <div class="header-title">
    <span>
        PGD - ${getConfig().metaHoras} Horas presenciais
    </span>

    <button
        id="editar-meta"
        class="edit-meta"
        title="Altere o valor da carga horária apenas se sua carga diferente da 64 horas. Feriados e pontos facultativos já são calculados."
    >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path fill="currentColor"
            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.04a1.003 1.003 0 0 0 0-1.42L18.21 3.29a1.003 1.003 0 0 0-1.42 0L14.71 5.37l3.75 3.75 2.25-1.91z"/>
    </svg>
    </button>
</div>
    <div class="close">✕</div>
  </div>
  <div class="content">
    <div class="progress">
      <div class="bar"></div>
    </div>
    <div style="margin-top:6px"> ${progresso.toFixed(1)}% </div>
    <div class="cards">
      <div class="card">
        <div class="t">Horas acumuladas</div>
        <div class="v"> ${fmtHM(dados.totalMinutos)} </div>
      </div>
      <div class="card">
        <div class="t">Horas faltantes</div>
        <div class="v"> ${fmtHM(horasFaltantes)} </div>
      </div>
      <div class="card">
        <div class="t">Dias de 8h necessários</div>
        <div class="v">${dias8h} dias</div>
      </div>
      <div class="card">
        <div class="t">Projeção de fechamento</div>
        <div class="v">${projecao}</div>
      </div>
      <div class="card">
        <div class="t">Dias úteis restantes</div>
        <div class="v">${diasRest} dias</div>
      </div>
    </div>
    <div class="card card-semana" style="grid-column:1/-1">
      <div class="t" style="text-align:center;font-size:12px;"> Dias considerados na projeção </div>
      <div class="dias-semana"> ${[ ['Segunda-feira',1], ['Terça-feira',2], ['Quarta-feira',3], ['Quinta-feira',4], ['Sexta-feira',5] ].map(([txt, valor]) => ` <button class="dia-btn ${
                    getConfig().diasSemana.includes(valor)
                        ? 'ativo'
                        : ''
                }" data-dia="${valor}"> ${txt} </button> `).join('')} </div>
    </div>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Horas</th>
            <th>Código - Afastamentos</th>
          </tr>
        </thead>
        <tbody> ${dados.dias .filter(d => d.minutos > 0) .map(d => ` <tr>
            <td>${d.data}</td>
            <td>${fmtHM(d.minutos)}</td>
            <td>${d.codigos?.length ? d.codigos.map(c => `${c.codigo} - ${c.descricao}`).join(' <br>') : ''} </td>
          </tr> `).join('')} </tbody>
      </table>
    </div>
  </div>
</div>
`;
    }
})();
