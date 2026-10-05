/* O motor da varredura. É o mesmo código pro botão "Varrer agora" e pro
   relógio automático — assim o que você testa na mão é exatamente o que roda
   sozinho de madrugada. */
const { redis, getJSON, setJSON, descobrePaginas, confere, telegram, host, NOMES } = require('./_lib');

const K = {
  doms: 'mon:doms',
  tg: 'mon:tg',
  cur: 'mon:cur',
  run: 'mon:run',
  pg: (d) => 'mon:pg:' + d,
};

const DIA = 86400000;

/* Roda N páginas por vez, em paralelo, sem passar do tempo. */
async function emLotes(itens, quantos, fn) {
  const fila = [...itens];
  const obreiros = Array.from({ length: Math.min(quantos, fila.length || 1) }, async () => {
    for (;;) {
      const it = fila.shift();
      if (it === undefined) return;
      await fn(it);
    }
  });
  await Promise.all(obreiros);
}

/* Pesca URLs de dentro de qualquer formato que o Radar tenha guardado.
   Nao sei de cor o formato dele, entao olho tudo e fico so com o que parece
   uma pagina daquele dominio. */
function colhe(valor, dominio, saida) {
  const base = 'https://' + dominio;
  const ruim = /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|webm|ico|woff2?|ttf)(\?|$)/i;
  const guarda = (p) => {
    if (typeof p !== 'string' || !p) return;
    let u = p.trim();
    if (/^https?:\/\//i.test(u)) { if (host(u) !== dominio) return; }
    else if (u.startsWith('/')) u = base + u;
    else return;
    if (ruim.test(u)) return;
    saida.add(u.split('#')[0].replace(/\/$/, '') || u);
  };
  const anda = (x, prof) => {
    if (x == null || prof > 4) return;
    if (typeof x === 'string') { guarda(x); return; }
    if (Array.isArray(x)) { x.forEach((y) => anda(y, prof + 1)); return; }
    if (typeof x === 'object') {
      if (x.path) guarda(x.path);
      if (x.url) guarda(x.url);
      if (x.slug) guarda('/' + String(x.slug).replace(/^\//, ''));
      Object.keys(x).forEach((k) => { guarda(k); anda(x[k], prof + 1); });
    }
  };
  anda(valor, 0);
}

/* Traz pro Monitor as paginas que o Radar ja descobriu desse dominio.
   Os dois usam o mesmo banco, entao e so ler do lado de la. */
async function importaDoRadar(dominio) {
  const chaves = new Set(['radar:seen:' + dominio, 'radar:pages:' + dominio, 'radar:paginas:' + dominio]);
  try {
    let cur = '0';
    for (let i = 0; i < 20; i++) {
      const r = await redis(['SCAN', cur, 'MATCH', 'radar:*' + dominio + '*', 'COUNT', '500']);
      cur = Array.isArray(r) ? String(r[0]) : '0';
      const lista = Array.isArray(r) ? (r[1] || []) : [];
      lista.forEach((k) => chaves.add(k));
      if (cur === '0') break;
    }
  } catch (e) { /* sem SCAN: fica so com os nomes conhecidos */ }

  const urls = new Set();
  for (const k of chaves) {
    const v = await getJSON(k, null);
    if (v != null) colhe(v, dominio, urls);
  }
  return [...urls];
}

/* Guarda no mapa do dominio uma lista de URLs vinda de fora
   (do Radar ou colada na mao). */
async function juntaUrls(dominio, urls) {
  const mapa = await getJSON(K.pg(dominio), {});
  const agora = Date.now();
  let novas = 0;
  for (const u of urls) {
    if (host(u) !== dominio) continue;
    if (!mapa[u]) { mapa[u] = { desde: agora, probs: [], saidas: [], check: 0 }; novas++; }
  }
  await setJSON(K.pg(dominio), mapa);
  return { total: Object.keys(mapa).length, novas };
}

/* Atualiza a lista de páginas de um domínio (sitemap, home e Radar). */
async function atualizaLista(dominio) {
  const mapa = await getJSON(K.pg(dominio), {});
  const achadas = await descobrePaginas(dominio);
  const agora = Date.now();
  let novas = 0;
  for (const u of achadas) {
    if (!mapa[u]) { mapa[u] = { desde: agora, probs: [], saidas: [], check: 0 }; novas++; }
    else mapa[u].viva = agora;
  }
  await setJSON(K.pg(dominio), mapa);
  return { total: Object.keys(mapa).length, novas, achadas: achadas.length };
}

/* A varredura em si. Devolve o que mudou, pra quem chamou decidir o aviso. */
async function varre(opts) {
  opts = opts || {};
  const limiteMs = opts.limiteMs || 230000;
  const t0 = Date.now();
  const acabou = () => Date.now() - t0 > limiteMs;

  const doms = await getJSON(K.doms, []);
  if (!doms.length) return { erro: 'nenhum domínio cadastrado' };

  const novos = [];      // começou a dar problema agora
  const lembretes = [];  // continua com problema e faz mais de 1 dia que avisei
  const voltaram = [];   // estava com problema e voltou ao normal
  let checadas = 0, comProblema = 0;

  for (const d of doms) {
    if (acabou()) break;
    const dom = d.dominio || d;
    let mapa = await getJSON(K.pg(dom), {});

    // lista velha (ou vazia) = procura as páginas de novo
    const idade = Date.now() - (d.listaEm || 0);
    if (!Object.keys(mapa).length || idade > 12 * 3600000 || opts.relistar) {
      await atualizaLista(dom);
      mapa = await getJSON(K.pg(dom), {});
      d.listaEm = Date.now();
    }

    // as mais esquecidas primeiro: assim tudo é checado por igual
    const urls = Object.keys(mapa).sort((a, b) => (mapa[a].check || 0) - (mapa[b].check || 0));
    const fatia = urls.slice(0, opts.porDominio || 400);

    await emLotes(fatia, opts.paralelo || 8, async (u) => {
      if (acabou()) return;
      const antes = mapa[u] || {};
      let r;
      try { r = await confere(u, antes); }
      catch (e) { r = { probs: [{ c: 'fora_do_ar', t: 'não consegui checar: ' + String((e && e.message) || e).slice(0, 70) }], saidas: antes.saidas || [] }; }

      checadas++;
      const assinatura = r.probs.map((x) => x.c).sort().join(',');
      const antesAss = (antes.probs || []).map((x) => x.c).sort().join(',');
      const agora = Date.now();

      if (r.probs.length) {
        comProblema++;
        const item = { dom, url: u, probs: r.probs };
        if (assinatura !== antesAss) novos.push(item);
        else if (agora - (antes.avisoEm || 0) > DIA) lembretes.push(item);
      } else if (antesAss) {
        voltaram.push({ dom, url: u });
      }

      mapa[u] = {
        desde: antes.desde || agora,
        probs: r.probs,
        saidas: r.saidas && r.saidas.length ? r.saidas : (antes.saidas || []),
        check: agora,
        ms: r.ms || null,
        avisoEm: r.probs.length
          ? ((assinatura !== antesAss || agora - (antes.avisoEm || 0) > DIA) ? agora : (antes.avisoEm || agora))
          : 0,
      };
    });

    await setJSON(K.pg(dom), mapa);
  }

  await setJSON(K.doms, doms);
  const resumo = {
    checadas, com_problema: comProblema,
    novos: novos.length, lembretes: lembretes.length, voltaram: voltaram.length,
    segundos: Math.round((Date.now() - t0) / 1000),
    quando: Date.now(),
    completou: !acabou(),
  };
  await setJSON(K.run, resumo);
  return { resumo, novos, lembretes, voltaram };
}

/* O recado do Telegram. Curto, direto, e com o link clicável. */
function recado(novos, lembretes, voltaram) {
  const linha = (i) => {
    const grave = '🔴';
    const quais = i.probs.map((p) => NOMES[p.c] || p.c).join(' + ');
    return grave + ' <b>' + esc(quais) + '</b>\n' + esc(i.url) + '\n<i>' + esc(i.probs[0].t) + '</i>';
  };
  const partes = [];
  if (novos.length) partes.push('<b>⚠️ PROBLEMA NOVO (' + novos.length + ')</b>\n\n' + novos.slice(0, 12).map(linha).join('\n\n') + (novos.length > 12 ? '\n\n… e mais ' + (novos.length - 12) : ''));
  if (lembretes.length) partes.push('<b>⏳ CONTINUA QUEBRADO (' + lembretes.length + ')</b>\n\n' + lembretes.slice(0, 8).map(linha).join('\n\n') + (lembretes.length > 8 ? '\n\n… e mais ' + (lembretes.length - 8) : ''));
  if (voltaram.length) partes.push('<b>✅ VOLTOU AO NORMAL (' + voltaram.length + ')</b>\n' + voltaram.slice(0, 10).map((v) => esc(v.url)).join('\n'));
  return partes;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function avisa(novos, lembretes, voltaram) {
  const cfg = await getJSON(K.tg, null);
  const partes = recado(novos, lembretes, voltaram);
  let enviados = 0;
  for (const p of partes) {
    const r = await telegram(cfg, p);
    if (r.ok) enviados++;
  }
  return enviados;
}

module.exports = { K, varre, avisa, atualizaLista, importaDoRadar, juntaUrls, emLotes };
