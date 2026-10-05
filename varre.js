/* POST /api/varre -> o botão "Varrer agora" do painel.
   Mesmo motor do automático, só com o relógio mais curto. */
const { json, senhaOk } = require('./_lib');
const { varre, avisa } = require('./_motor');

module.exports = async (req, res) => {
  if (!senhaOk(req)) return json(res, 401, { erro: 'senha' });
  if (req.method !== 'POST') return json(res, 405, { erro: 'metodo' });
  try {
    const r = await varre({ limiteMs: 220000, paralelo: 8, porDominio: 400, relistar: false });
    if (r.erro) return json(res, 400, r);
    const enviados = await avisa(r.novos, r.lembretes, r.voltaram);
    return json(res, 200, { ok: true, ...r.resumo, telegram: enviados });
  } catch (e) {
    return json(res, 500, { erro: 'falha', mensagem: String((e && e.message) || e) });
  }
};
