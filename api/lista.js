/* POST /api/lista -> atualizar a lista de páginas de um domínio.
   { dominio }                 -> sitemap + home + o que o Radar já sabe
   { dominio, texto }          -> acrescenta os endereços colados na mão */
const { json, corpo, senhaOk, limpaDominio, host } = require('./_lib');
const { atualizaLista, juntaUrls } = require('./_motor');

module.exports = async (req, res) => {
  if (!senhaOk(req)) return json(res, 401, { erro: 'senha' });
  if (req.method !== 'POST') return json(res, 405, { erro: 'metodo' });
  const b = await corpo(req);
  const d = limpaDominio(b.dominio);
  if (!d) return json(res, 400, { erro: 'dominio' });

  try {
    /* Texto colado: aceita qualquer bagunça. Pega endereço inteiro, caminho
       começando com barra e também só o slug solto numa linha. */
    const texto = String(b.texto || (Array.isArray(b.urls) ? b.urls.join('\n') : '') || '');
    if (texto.trim()) {
      const achadas = new Set();
      for (const m of texto.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
        const u = m[0].replace(/[.,;]+$/, '');
        if (host(u) === d) achadas.add(u.split('#')[0].replace(/\/$/, ''));
      }
      for (const linha of texto.split(/[\n\r,;|\t]+/)) {
        const t = linha.trim();
        if (!t || /^https?:\/\//i.test(t)) continue;
        if (/\s/.test(t)) continue;                 // frase, não é endereço
        if (!/^[/a-z0-9][a-z0-9\-_/]*$/i.test(t)) continue;
        if (/\.(jpg|jpeg|png|gif|webp|css|js|pdf)$/i.test(t)) continue;
        achadas.add('https://' + d + '/' + t.replace(/^\/+/, '').replace(/\/$/, ''));
      }
      if (!achadas.size) {
        return json(res, 400, { erro: 'urls', mensagem: 'Não achei nenhum endereço de ' + d + ' no texto que você colou.' });
      }
      return json(res, 200, { ok: true, ...(await juntaUrls(d, [...achadas])) });
    }

    return json(res, 200, { ok: true, ...(await atualizaLista(d)) });
  } catch (e) {
    return json(res, 500, { erro: 'falha', mensagem: String((e && e.message) || e) });
  }
};
