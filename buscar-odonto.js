const fs = require('fs');
const path = require('path');
const { abrirNavegador, novaPagina, listarResultados, extrairLocal, limparUrl, semAcento, pausa, idDoLocal } = require('./buscar-leads');

// Teresópolis é DDD 21: fica de fora da busca, já que só entram telefones do DDD 24
const CIDADES = [
  'Petrópolis', 'Volta Redonda', 'Barra Mansa', 'Resende', 'Angra dos Reis',
  'Três Rios', 'Barra do Piraí', 'Valença', 'Itatiaia', 'Paraty',
];
const TERMOS = ['clínica odontológica', 'implantes dentários', 'odontologia estética', 'harmonização orofacial'];
const TOP = 100;
const MIN_AVALIACOES = 30;
const NOTA_MIN = 4.7;
const SALVAR_A_CADA = 15;
const BRUTO = path.join(__dirname, 'clinicas_odonto_bruto.json');
const SAIDA = path.join(__dirname, 'clinicas-odonto-ddd24.json');

// Pela categoria do Maps: o nome não basta, porque a busca por harmonização traz clínicas de estética facial
// e a de clínica odontológica traz redes de cartão de saúde e clínicas médicas
const ODONTO = /odonto|dentist|dentari|ortodon|periodon|endodon|protese dentaria|cirurgia bucomaxilo/;
// Links que não são site próprio: com eles a clínica entra na lista prioritária
const HOSTS_SEM_SITE = ['instagram.com', 'instagr.am', 'linktr.ee', 'linktree.com', 'beacons.ai', 'taplink.cc', 'facebook.com', 'fb.com', 'fb.me', 'wa.me', 'whatsapp.com'];
const HOSTS_AGREGADORES = ['linktr.ee', 'linktree.com', 'beacons.ai', 'taplink.cc'];
const HOSTS_GOOGLE = ['google.com', 'google.com.br', 'goo.gl', 'business.site'];

const PERFIS_DE_PLATAFORMA = ['whatsapp', 'bitly', 'linktree_', 'linktr.ee', 'instagram', 'facebook', 'meta', 'beacons.ai', 'taplink.cc', 'wix', 'canva'];

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const hostEm = (h, lista) => lista.some((x) => h === x || h.endsWith('.' + x));

// Só perfis (instagram.com/<usuario>), não posts, reels ou a página inicial
function perfilInstagram(url) {
  const u = limparUrl(url);
  if (!hostEm(host(u), ['instagram.com', 'instagr.am'])) return null;
  const usuario = new URL(u).pathname.split('/').filter(Boolean)[0];
  if (!usuario || /^(p|reel|reels|explore|stories|accounts|tv|direct)$/.test(usuario)) return null;
  // Perfis das próprias plataformas, vindos do rodapé de páginas do WhatsApp, bit.ly, Linktree etc.
  if (PERFIS_DE_PLATAFORMA.includes(usuario.toLowerCase())) return null;
  return `https://www.instagram.com/${usuario}/`;
}

function avaliacoesDoCartao(texto) {
  const m = (texto || '').match(/(\d[.,]\d)\s*\(([\d.]+)\)/);
  return m ? { nota: parseFloat(m[1].replace(',', '.')), qtd: parseInt(m[2].replace(/\./g, ''), 10) } : null;
}

function cartaoDescartavel(c) {
  if (/fechado (temporariamente|permanentemente)|sem avalia/i.test(c.texto || '')) return true;
  const av = avaliacoesDoCartao(c.texto);
  return Boolean(av) && (av.qtd < MIN_AVALIACOES || av.nota < NOTA_MIN);
}

// Celular do DDD 24 (24 9XXXX-XXXX): o único tipo de número que pode ter WhatsApp
const digitosDoTelefone = (tel) => (tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const celularDDD24 = (tel) => /^249\d{8}$/.test(digitosDoTelefone(tel));

// Campos da ficha que o extrairLocal não lê; corre na mesma página, logo depois dele
function detalhesDaFicha(page) {
  return page.evaluate(() => {
    const main = document.querySelector('div[role="main"]');
    const rotulo = (el) => (el ? (el.getAttribute('aria-label') || el.innerText || '').replace(/^[^:]+:\s*/, '').trim() : '');
    const distribuicao = {};
    for (const tr of document.querySelectorAll('tr.BHOKXe')) {
      const m = (tr.getAttribute('aria-label') || '').match(/(\d)\s*estrelas?,\s*([\d.]+)/i);
      if (m) distribuicao[m[1]] = parseInt(m[2].replace(/\./g, ''), 10);
    }
    const horarios = [...document.querySelectorAll('table.eK4R0e tr')]
      .map((tr) => ({
        day: (tr.querySelector('td.ylH6lf')?.innerText || '').trim(),
        hours: (tr.querySelector('td.mxowUb')?.getAttribute('aria-label') || tr.querySelector('td.mxowUb')?.innerText || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((h) => h.day);
    const texto = main?.innerText || '';
    return {
      description: (document.querySelector('div.PYvSYb')?.innerText || '').trim() || null,
      plusCode: rotulo(document.querySelector('[data-item-id="oloc"]')) || null,
      locatedIn: rotulo(document.querySelector('[data-item-id="locatedin"]')) || null,
      distribuicao,
      horarios,
      temporarilyClosed: /fechado temporariamente|temporarily closed/i.test(texto),
      permanentlyClosed: /fechado permanentemente|permanently closed/i.test(texto),
      reivindicar: Boolean(document.querySelector('a[data-item-id="merchant"]')) || /reivindicar (esta|este) (empresa|perfil)|claim this business/i.test(texto),
      links: [...(main?.querySelectorAll('a[href]') || [])].map((a) => a.href).filter((h) => /^https?:/.test(h)),
    };
  });
}

// Procura o perfil do Instagram dentro do Linktree ou do site vinculado
async function instagramDoSite(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));
    const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    return links.map(perfilInstagram).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function coletar() {
  const bruto = fs.existsSync(BRUTO) ? JSON.parse(fs.readFileSync(BRUTO, 'utf8')) : [];
  const visitados = new Set(bruto.map((l) => l.id));
  const salvar = () => fs.writeFileSync(BRUTO, JSON.stringify(bruto, null, 2));

  const browser = await abrirNavegador();
  const encerrar = async (codigo) => {
    salvar();
    await browser.close().catch(() => {});
    process.exit(codigo);
  };
  process.on('SIGINT', () => encerrar(130));
  process.on('SIGTERM', () => encerrar(143));

  let bloqueado = false;
  try {
    const page = await novaPagina(browser);
    busca: for (const termo of TERMOS) {
      for (const cidade of CIDADES) {
        let cartoes = [];
        try {
          await pausa();
          cartoes = await listarResultados(page, termo, cidade);
        } catch (e) {
          console.log(`! Falha na busca "${termo}" em ${cidade}: ${e.message}`);
        }
        if (page.url().includes('/sorry/')) {
          bloqueado = true;
          break busca;
        }
        const candidatos = cartoes.filter((c) => !cartaoDescartavel(c) && !visitados.has(idDoLocal(c.href)));
        console.log(`\n> "${termo}" em ${cidade}: ${cartoes.length} resultados, ${candidatos.length} fichas a visitar`);

        for (const c of candidatos) {
          const id = idDoLocal(c.href);
          visitados.add(id);
          try {
            await pausa();
            const dados = await extrairLocal(page, c.href).catch(() => extrairLocal(page, c.href));
            const extra = await detalhesDaFicha(page).catch(() => ({ links: [] }));
            const registro = { id, termoBusca: termo, cidadeBusca: cidade, ...dados, ...extra, nome: dados.nome || c.nome, scrapedAt: new Date().toISOString() };
            // Só vale a visita ao site/Linktree para quem já passa nos critérios
            const site = limparUrl(dados.siteUrl);
            registro.instagramUrl = [site, dados.instagramUrl, ...extra.links].map(perfilInstagram).find(Boolean) || null;
            if (!registro.instagramUrl && site && !hostEm(host(site), [...HOSTS_GOOGLE, 'wa.me', 'whatsapp.com', 'api.whatsapp.com']) && dados.totalScore >= NOTA_MIN && dados.reviewsCount >= MIN_AVALIACOES && celularDDD24(dados.telefone)) {
              registro.instagramUrl = await instagramDoSite(page, site);
            }
            bruto.push(registro);
            console.log(`  [${bruto.length}] ${registro.nome} — ${dados.totalScore} ★ (${dados.reviewsCount}) ${dados.telefone}${registro.instagramUrl ? ' · IG' : ''}`);
          } catch (e) {
            console.log(`  ! ${c.nome}: ${e.message.split('\n')[0]}`);
          }
          if (page.url().includes('/sorry/')) {
            bloqueado = true;
            break busca;
          }
          if (bruto.length % SALVAR_A_CADA === 0) salvar();
        }
        salvar();
      }
    }
  } finally {
    salvar();
    await browser.close().catch(() => {});
  }
  if (bloqueado) console.log('Atenção: o Google Maps pediu CAPTCHA; a recolha parou e o que já havia foi gravado.');
}

const ESTADOS = { RJ: 'Rio de Janeiro', SP: 'São Paulo', MG: 'Minas Gerais' };

// O Maps escreve "Rua, nº - Bairro, Cidade - UF, CEP" ou, sem bairro, "Rua, nº - Cidade, UF, CEP"
function partesDoEndereco(endereco) {
  let resto = (endereco || '').trim();
  const tirar = (re) => {
    const m = resto.match(re);
    if (m) resto = resto.slice(0, m.index);
    return m ? m[1] : null;
  };
  const postalCode = tirar(/,\s*(\d{5}(?:-\d{3})?)$/);
  const uf = tirar(/(?:\s+-\s+|,\s*)([A-Z]{2})$/);
  if (!uf) return { street: resto || null, neighborhood: null, city: null, state: null, postalCode };
  const virgula = resto.lastIndexOf(', ');
  const traco = resto.lastIndexOf(' - ');
  const corte = Math.max(virgula, traco);
  const city = corte < 0 ? resto : resto.slice(corte).replace(/^(, | - )/, '');
  resto = corte < 0 ? '' : resto.slice(0, corte);
  const bairro = virgula > traco ? resto.lastIndexOf(' - ') : -1;
  return {
    street: (bairro < 0 ? resto : resto.slice(0, bairro)) || null,
    neighborhood: bairro < 0 ? null : resto.slice(bairro + 3),
    city,
    state: ESTADOS[uf] || null,
    postalCode,
  };
}

function montarSaida(l, digitos, gravadoEm) {
  const mapsUrl = l.mapsUrl || '';
  const [, lat, lng] = mapsUrl.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) || [];
  const fid = /^0x[0-9a-f]+:0x[0-9a-f]+$/.test(l.id || '') ? l.id : null;
  const cid = fid ? BigInt(fid.split(':')[1]).toString() : null;
  const e = partesDoEndereco(l.endereco);
  const d = l.distribuicao || {};
  const estrelas = (n) => (n in d ? d[n] : null);
  return {
    title: l.nome,
    subTitle: null,
    description: l.description || null,
    ownerDescription: null,
    price: null,
    categoryName: l.categoria || null,
    address: l.endereco ? `${l.endereco}, Brasil` : null,
    neighborhood: e.neighborhood,
    street: e.street,
    city: e.city,
    postalCode: e.postalCode,
    state: e.state,
    countryCode: 'BR',
    phone: `+55 ${digitos.slice(0, 2)} ${digitos.slice(2, 7)}-${digitos.slice(7)}`,
    phoneUnformatted: '+55' + digitos,
    claimThisBusiness: l.reivindicar ?? null,
    location: { lat: lat ? parseFloat(lat) : null, lng: lng ? parseFloat(lng) : null },
    locatedIn: l.locatedIn || null,
    floor: null,
    plusCode: l.plusCode || null,
    menu: null,
    servicesLink: null,
    totalScore: l.totalScore,
    permanentlyClosed: Boolean(l.permanentlyClosed),
    temporarilyClosed: Boolean(l.temporarilyClosed),
    placeId: (mapsUrl.match(/!19s([\w-]+)/) || [])[1] || null,
    categories: l.categoria ? [l.categoria] : [],
    fid,
    cid,
    reviewsCount: l.reviewsCount,
    reviewsDistribution: { oneStar: estrelas(1), twoStar: estrelas(2), threeStar: estrelas(3), fourStar: estrelas(4), fiveStar: estrelas(5) },
    imagesCount: null,
    imageCategories: [],
    scrapedAt: l.scrapedAt || gravadoEm,
    reserveTableUrl: null,
    googleFoodUrl: null,
    hotelStars: null,
    hotelDescription: null,
    checkInDate: null,
    checkOutDate: null,
    hotelAds: [],
    popularTimesLiveText: null,
    popularTimesLivePercent: null,
    popularTimesHistogram: {},
    openingHours: l.horarios || [],
    url: cid ? `https://maps.google.com/?cid=${cid}` : mapsUrl,
    instagramUrl: perfilInstagram(l.instagramUrl),
  };
}

// Devolve a clínica qualificada ou o motivo da reprovação
function qualificar(l, gravadoEm) {
  if (l.fechado || l.temporarilyClosed || l.permanentlyClosed) return { motivo: 'fechado' };
  if (!l.nome || !l.mapsUrl) return { motivo: 'dados incompletos' };
  if (!ODONTO.test(semAcento(l.categoria))) return { motivo: 'não é clínica odontológica' };
  if (!(l.reviewsCount >= MIN_AVALIACOES)) return { motivo: `menos de ${MIN_AVALIACOES} avaliações` };
  if (!(l.totalScore >= NOTA_MIN)) return { motivo: `nota abaixo de ${NOTA_MIN}` };
  const digitos = digitosDoTelefone(l.telefone);
  if (!/^249\d{8}$/.test(digitos)) return { motivo: 'sem celular/WhatsApp do DDD 24' };

  const site = limparUrl(l.siteUrl);
  const semSite = !site || hostEm(host(site), HOSTS_SEM_SITE) || hostEm(host(site), HOSTS_GOOGLE);
  return { semSite, lead: montarSaida(l, digitos, gravadoEm) };
}

function filtrar() {
  const bruto = JSON.parse(fs.readFileSync(BRUTO, 'utf8'));
  const gravadoEm = fs.statSync(BRUTO).mtime.toISOString();
  const reprovados = {};
  const telefones = new Set();
  const ids = new Set();
  const aprovados = [];
  for (const l of [...bruto].sort((a, b) => (b.reviewsCount || 0) - (a.reviewsCount || 0))) {
    const q = qualificar(l, gravadoEm);
    if (q.lead && (telefones.has(q.lead.phoneUnformatted) || ids.has(l.id))) q.motivo = 'contato repetido';
    if (q.motivo) {
      reprovados[q.motivo] = (reprovados[q.motivo] || 0) + 1;
      continue;
    }
    telefones.add(q.lead.phoneUnformatted);
    ids.add(l.id);
    aprovados.push(q);
  }
  // Sem site próprio (ou só Instagram/Linktree) primeiro; depois mais avaliações e maior nota
  aprovados.sort((a, b) => b.semSite - a.semSite || b.lead.reviewsCount - a.lead.reviewsCount || b.lead.totalScore - a.lead.totalScore);
  const top = aprovados.slice(0, TOP);
  fs.writeFileSync(SAIDA, JSON.stringify(top.map((q) => q.lead), null, 2));

  const porCidade = top.reduce((acc, q) => ({ ...acc, [q.lead.city]: (acc[q.lead.city] || 0) + 1 }), {});
  console.log(`\n${bruto.length} fichas visitadas, ${aprovados.length} qualificadas; ${top.length} gravadas em ${SAIDA}`);
  console.log(`Sem site próprio: ${top.filter((q) => q.semSite).length} · com Instagram: ${top.filter((q) => q.lead.instagramUrl).length}`);
  console.log('Reprovadas por:', reprovados);
  console.log('Por cidade:', porCidade);
  if (top.length < TOP) console.log(`Atenção: só ${top.length} clínicas passaram em todos os critérios, abaixo das ${TOP} pedidas.`);
}

(async () => {
  if (!process.argv.includes('--filtrar')) await coletar();
  filtrar();
})().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
