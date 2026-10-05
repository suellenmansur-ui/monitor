/* GET  /api/estado  -> tudo que o painel precisa desenhar
   POST /api/estado  -> cadastrar/remover domínio, salvar Telegram */
const { getJSON, setJSON, json, corpo, senhaOk, limpaDominio, telegram, NOMES } = require('./_lib');
const { K } = require('./_motor');

module.exports = async (req, res) => {
  if (!senhaOk(req)) return json(res, 401, { erro: 'senha' });

  if (req.method === 'GET') {
    const doms = await getJSON(K.doms, []);
    const tg = await getJSON(K.tg, null);
    const run = await getJSON(K.run, null);
    const saida = [];
    for (const d of doms) {
      const mapa = await getJSON(K.pg(d.dominio), {});
      const urls = Object.keys(mapa);
      const comProb = urls.filter((u) => (mapa[u].probs || []).length);
      saida.push({
        dominio: d.dominio,
        desde: d.desde || null,
        listaEm: d.listaEm || 0,
        paginas: urls.length,
        problemas: comProb.length,
        itens: comProb.map((u) => ({ url: u, probs: mapa[u].probs, desde: mapa[u].desde, check: mapa[u].check })),
        todas: urls.map((u) => ({ url: u, ok: !(mapa[u].probs || []).length, check: mapa[u].check || 0 })),
      });
    }
    return json(res, 200, { dominios: saida, telegram: tg ? { chat: tg.chat, tem: true } : { tem: false }, ultima: run, nomes: NOMES });
  }

  if (req.method !== 'POST') return json(res, 405, { erro: 'metodo' });
  const b = await corpo(req);
  const acao = String(b.acao || '');

  if (acao === 'add') {
    const d = limpaDominio(b.dominio);
    if (!d) return json(res, 400, { erro: 'dominio_invalido', mensagem: 'Escreva só o domínio, assim: seusite.com.br' });
    const doms = await getJSON(K.doms, []);
    if (doms.some((x) => x.dominio === d)) return json(res, 200, { ok: true, jaTinha: true });
    doms.push({ dominio: d, desde: Date.now(), listaEm: 0 });
    await setJSON(K.doms, doms);
    return json(res, 200, { ok: true, dominio: d });
  }

  if (acao === 'remove') {
    const d = limpaDominio(b.dominio);
    const doms = (await getJSON(K.doms, [])).filter((x) => x.dominio !== d);
    await setJSON(K.doms, doms);
    await setJSON(K.pg(d), {});
    return json(res, 200, { ok: true });
  }

  if (acao === 'telegram') {
    const token = String(b.token || '').trim();
    const chat = String(b.chat || '').trim();
    if (!token || !chat) { await setJSON(K.tg, null); return json(res, 200, { ok: true, limpou: true }); }
    const cfg = { token, chat };
    const t = await telegram(cfg, '✅ Monitor conectado. É por aqui que eu te aviso quando uma página quebrar.');
    if (!t.ok) return json(res, 400, { erro: 'telegram', mensagem: t.erro || 'não consegui mandar a mensagem de teste' });
    await setJSON(K.tg, cfg);
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { erro: 'acao' });
};
