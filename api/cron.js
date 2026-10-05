/* GET /api/cron -> a varredura automática (3x por dia, pela Vercel).
   Só roda com o segredo certo: ninguém dispara isso pela internet. */
const { json } = require('./_lib');
const { varre, avisa } = require('./_motor');

module.exports = async (req, res) => {
  const segredo = process.env.CRON_SECRET || '';
  const auth = req.headers.authorization || '';
  const naQuery = (req.query && req.query.k) || '';
  if (!segredo || (auth !== 'Bearer ' + segredo && naQuery !== segredo)) {
    return json(res, 401, { erro: 'nao_autorizado' });
  }
  try {
    const r = await varre({ limiteMs: 240000, paralelo: 10, porDominio: 600, relistar: false });
    if (r.erro) return json(res, 200, { ok: true, nada: r.erro });
    const enviados = await avisa(r.novos, r.lembretes, r.voltaram);
    return json(res, 200, { ok: true, ...r.resumo, telegram: enviados });
  } catch (e) {
    return json(res, 500, { erro: 'falha', mensagem: String((e && e.message) || e) });
  }
};
