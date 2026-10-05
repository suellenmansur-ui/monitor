/* POST /api/lista -> "procurar páginas de novo" (relê o sitemap do domínio). */
const { json, corpo, senhaOk, limpaDominio } = require('./_lib');
const { atualizaLista } = require('./_motor');

module.exports = async (req, res) => {
  if (!senhaOk(req)) return json(res, 401, { erro: 'senha' });
  if (req.method !== 'POST') return json(res, 405, { erro: 'metodo' });
  const b = await corpo(req);
  const d = limpaDominio(b.dominio);
  if (!d) return json(res, 400, { erro: 'dominio' });
  try { return json(res, 200, { ok: true, ...(await atualizaLista(d)) }); }
  catch (e) { return json(res, 500, { erro: 'falha', mensagem: String((e && e.message) || e) }); }
};
