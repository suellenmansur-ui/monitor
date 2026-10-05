/* Monitor — biblioteca comum.
   Guarda tudo no Upstash Redis (o mesmo que o Radar usa, com outro prefixo).
   Nenhuma chave sai daqui pro navegador. */

/* Aceita os dois nomes: os que a integracao Upstash/KV da Vercel cria sozinha
   (KV_REST_API_URL / KV_REST_API_TOKEN, que e o que o Radar usa) e os nomes
   avulsos do painel da Upstash. Assim basta conectar o banco no projeto. */
const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redis(comando) {
  if (!U || !T) throw new Error('Banco nao conectado: falta KV_REST_API_URL / KV_REST_API_TOKEN (conecte o Upstash no projeto, em Storage)');
  const r = await fetch(U, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  if (!r.ok) throw new Error('redis ' + r.status + ' ' + (await r.text()).slice(0, 150));
  const j = await r.json();
  return j.result;
}

async function getJSON(chave, padrao) {
  try {
    const v = await redis(['GET', chave]);
    if (v == null) return padrao;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) { return padrao; }
}
async function setJSON(chave, valor) {
  return redis(['SET', chave, JSON.stringify(valor)]);
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function corpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = '';
  for await (const p of req) s += p;
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

/* A senha é opcional. Sem SENHA no ambiente, o painel abre pra qualquer um
   que tenha o link — então defina uma. */
function senhaOk(req) {
  const s = process.env.SENHA || '';
  if (!s) return true;
  const dada = req.headers['x-senha'] || '';
  return String(dada) === s;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Uma busca que nunca trava a função: tem relógio próprio. */
async function pega(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 15000;
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch (e) {} }, ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const txt = opt.corpo === false ? '' : (await r.text().catch(() => ''));
    return { ok: r.ok, status: r.status, txt, final: r.url || url, ms: Date.now() - t0, bytes: txt.length };
  } catch (e) {
    return { ok: false, status: 0, txt: '', final: url, ms: Date.now() - t0, bytes: 0, erro: String((e && e.name === 'AbortError') ? 'demorou demais' : (e && e.message) || e).slice(0, 90) };
  } finally { clearTimeout(t); }
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function limpaDominio(d) {
  let s = String(d || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\s/g, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

/* Hosts que NUNCA são link de afiliado: redes sociais, CDNs, fontes, analytics.
   Se um link aponta pra cá, ele não entra na conta de "link de saída". */
const NEUTROS = /(^|\.)(google|googletagmanager|google-analytics|gstatic|googleapis|doubleclick|facebook|fb|instagram|twitter|x|t|linkedin|pinterest|youtube|youtu|tiktok|whatsapp|wa|telegram|cloudflare|jsdelivr|unpkg|cdnjs|bootstrapcdn|fontawesome|gravatar|wp|wordpress|w3|schema|paypal|stripe|trustpilot|bbb|archive|wikipedia)\.(com|net|org|io|be|me|br|co)$/i;

/* Tira do HTML todos os links que saem do próprio domínio.
   Esses são os candidatos a link de afiliado. */
function linksDeSaida(html, dominioDaPagina) {
  const achados = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const bruto = m[1].trim();
    if (!/^https?:\/\//i.test(bruto)) continue;
    const h = host(bruto);
    if (!h || h === dominioDaPagina || h.endsWith('.' + dominioDaPagina)) continue;
    if (NEUTROS.test(h)) continue;
    if (!achados.has(h)) achados.set(h, bruto);
    if (achados.size >= 4) break;
  }
  return [...achados.values()];
}

/* A página de destino existe mas a oferta acabou? */
const MORTA = /(no longer available|not available|out of stock|sold out|offer (?:has )?(?:ended|expired)|campaign (?:has )?ended|currently unavailable|this offer is closed|page not found|404 not found|esgotado|indispon[ií]vel|oferta encerrada)/i;
function ofertaMorta(r) {
  if (!r || !r.ok) return false;
  const corpo = String(r.txt || '');
  if (corpo.replace(/\s/g, '').length < 500) return true;
  return MORTA.test(corpo.slice(0, 60000));
}

/* Lê um sitemap (inclusive sitemap de sitemaps) e devolve as URLs. */
async function urlsDoSitemap(url, profundidade) {
  const saida = [];
  const r = await pega(url, { ms: 15000 });
  if (!r.ok || !r.txt) return saida;
  const locs = [...r.txt.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const ehIndice = /<sitemapindex/i.test(r.txt);
  if (ehIndice && (profundidade || 0) < 2) {
    for (const l of locs.slice(0, 25)) {
      const sub = await urlsDoSitemap(l, (profundidade || 0) + 1);
      for (const u of sub) saida.push(u);
      if (saida.length > 3000) break;
    }
    return saida;
  }
  for (const l of locs) saida.push(l);
  return saida;
}

/* Descobre as páginas de um domínio: primeiro pelo sitemap (é o certo),
   e se não houver sitemap, lendo os links da home. */
async function descobrePaginas(dominio) {
  const base = 'https://' + dominio;
  let urls = [];

  /* 1) o robots.txt costuma dizer onde fica o sitemap */
  const doRobots = [];
  try {
    const rb = await pega(base + '/robots.txt', { ms: 10000 });
    if (rb.ok && rb.txt) {
      for (const m of rb.txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)) doRobots.push(m[1]);
    }
  } catch (e) { /* sem robots, segue */ }

  /* 2) os caminhos de sitemap mais usados, inclusive os do WordPress e do Yoast */
  const tentativas = [
    ...doRobots,
    base + '/sitemap.xml', base + '/sitemap_index.xml', base + '/sitemap-index.xml',
    base + '/wp-sitemap.xml', base + '/wp-sitemap-posts-page-1.xml', base + '/wp-sitemap-posts-post-1.xml',
    base + '/page-sitemap.xml', base + '/post-sitemap.xml',
  ];
  for (const cam of tentativas) {
    const achou = await urlsDoSitemap(cam, 0);
    if (achou.length) { urls = achou; break; }
  }

  /* 3) a lista de páginas do próprio WordPress, quando ele deixa ler */
  if (!urls.length) {
    for (const cam of ['/wp-json/wp/v2/pages?per_page=100&_fields=link', '/wp-json/wp/v2/posts?per_page=100&_fields=link']) {
      try {
        const r = await pega(base + cam, { ms: 15000 });
        if (!r.ok || !r.txt || r.txt[0] !== '[') continue;
        const lista = JSON.parse(r.txt);
        if (Array.isArray(lista) && lista.length) {
          for (const it of lista) if (it && it.link) urls.push(it.link);
        }
      } catch (e) { /* bloqueado ou desligado: segue */ }
    }
  }
  if (!urls.length) {
    /* Sem sitemap: anda pelos links do site. Visita ate 15 paginas, mas
       recolhe TODOS os endereços que encontrar no caminho — assim acha
       tambem o que esta a dois cliques da home, nao so o menu. */
    const vistos = new Set();
    const fila = [base + '/'];
    for (let i = 0; i < fila.length && i < 15 && vistos.size < 600; i++) {
      const r = await pega(fila[i], { ms: 15000 });
      vistos.add(fila[i]);
      if (!r.ok || !r.txt) continue;
      const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(r.txt)) && vistos.size < 600) {
        let u = m[1].trim();
        if (/^(#|mailto:|tel:|javascript:)/i.test(u)) continue;
        if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, fila[i]).href; } catch (e) { continue; } }
        if (host(u) !== dominio) continue;
        u = u.split('#')[0];
        if (vistos.has(u)) continue;
        vistos.add(u);
        if (fila.length < 15) fila.push(u);
      }
    }
    urls = [...vistos];
  }
  const fora = /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip|mp4|webm|ico|woff2?|ttf)(\?|$)/i;
  const limpas = new Set();
  for (const u of urls) {
    if (host(u) !== dominio) continue;
    if (fora.test(u)) continue;
    limpas.add(u.split('#')[0].replace(/\/$/, '') || u);
    if (limpas.size >= 1200) break;
  }
  return [...limpas];
}

/* ---- os 4 problemas que quebram a venda ---- */
const NOMES = {
  fora_do_ar: 'Página fora do ar',
  sem_link: 'Página perdeu o link de afiliado',
  link_quebrado: 'Link de afiliado quebrado',
  oferta_pausada: 'Oferta parece pausada',
};

/* Confere UMA página. 'antes' é como ela estava na última varredura:
   é por isso que o monitor sabe que a página PERDEU o link. */
async function confere(url, antes) {
  const dom = host(url);
  const probs = [];
  const r = await pega(url, { ms: 20000 });

  if (r.erro || !(r.status >= 200 && r.status < 400)) {
    probs.push({ c: 'fora_do_ar', t: r.erro ? ('não respondeu: ' + r.erro) : ('respondeu ' + r.status) });
    return { probs, saidas: (antes && antes.saidas) || [], ms: r.ms };
  }

  const saidas = linksDeSaida(r.txt, dom);
  const tinhaAntes = !!(antes && antes.saidas && antes.saidas.length);

  if (!saidas.length && tinhaAntes) {
    probs.push({ c: 'sem_link', t: 'ontem a página tinha link de saída (' + host(antes.saidas[0]) + ') e hoje não tem mais' });
  }

  for (const link of saidas.slice(0, 2)) {
    const a = await pega(link, { ms: 15000 });
    if (a.erro || !(a.status >= 200 && a.status < 400)) {
      probs.push({ c: 'link_quebrado', t: host(link) + (a.erro ? (' — ' + a.erro) : ' — respondeu ' + a.status) });
    } else if (ofertaMorta(a)) {
      probs.push({ c: 'oferta_pausada', t: 'o destino (' + host(link) + ') abre, mas parece pausado ou esgotado' });
    }
  }

  return { probs, saidas, ms: r.ms };
}

/* ---- Telegram ---- */
async function telegram(cfg, texto) {
  if (!cfg || !cfg.token || !cfg.chat) return { pulou: 'telegram não configurado' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chat, text: texto, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) return { erro: (await r.text()).slice(0, 180) };
    return { ok: true };
  } catch (e) { return { erro: String((e && e.message) || e).slice(0, 120) }; }
}

module.exports = {
  redis, getJSON, setJSON, json, corpo, senhaOk,
  pega, host, limpaDominio, linksDeSaida, ofertaMorta,
  descobrePaginas, confere, telegram, NOMES,
};
