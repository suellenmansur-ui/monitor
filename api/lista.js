/* POST /api/lista -> atualizar a lista de páginas de um domínio.
   { dominio }                 -> sitemap + home + o que o Radar já sabe
   { dominio, urls:[...] }     -> acrescenta URLs coladas na mão
   { dominio, soRadar:true }   -> só a importação do Radar */
const { json, corpo, senhaOk, limpaDominio, host } = require('./_lib');
const { atualizaLista, importaDoRadar, juntaUrls } = require('./_motor');

module.exports = async (req, res) => {
  if (!senhaOk(req)) return json(res, 401, { erro: 'senha' });
  if (req.method !== 'POST') return json(res, 405, { erro: 'metodo' });
  const b = await corpo(req);
  const d = limpaDominio(b.dominio);
  if (!d) return json(res, 400, { erro: 'dominio' });

  try {
    if (Array.isArray(b.urls) && b.urls.length) {
      const limpas = b.urls
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .map((x) => (/^https?:\/\//i.test(x) ? x : 'https://' + d + (x.startsWith('/') ? x : '/' + x)))
        .filter((x) => host(x) === d);
      if (!limpas.length) return json(res, 400, { erro: 'urls', mensagem: 'Nenhuma URL desse domínio na lista que você colou.' });
      return json(res, 200, { ok: true, ...(await juntaUrls(d, limpas)) });
    }

    if (b.soRadar) {
      const doRadar = await importaDoRadar(d);
      if (!doRadar.length) return json(res, 200, { ok: true, total: 0, novas: 0, vazio: true });
      return json(res, 200, { ok: true, ...(await juntaUrls(d, doRadar)) });
    }

    return json(res, 200, { ok: true, ...(await atualizaLista(d)) });
  } catch (e) {
    return json(res, 500, { erro: 'falha', mensagem: String((e && e.message) || e) });
  }
};
