const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const CIDADES = ['Petrópolis', 'Três Rios', 'Areal', 'Paraíba do Sul'];
const NICHOS = ['dentista', 'marmoraria', 'vidraçaria', 'oficina mecanica', 'estetica automotiva', 'pet shop'];
const META = 40;
const MAX_ROLAGENS = 12;
const ARQUIVO = path.join(__dirname, 'leads.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// "Sites" que não são site próprio: redes sociais, agregadores de link, WhatsApp etc.
const HOSTS_GENERICOS = [
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'wa.me', 'whatsapp.com', 'linktr.ee', 'linktree.com',
  'bit.ly', 'tinyurl.com', 'youtube.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com',
  'ifood.com.br', 'google.com', 'goo.gl', 'business.site', 'negocio.site', 'beacons.ai', 'taplink.cc',
  'olx.com.br', 'mercadolivre.com.br', 'doctoralia.com.br', 'booksy.com', 'canva.site',
];

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function hostGenerico(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return HOSTS_GENERICOS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return true;
  }
}

// O Maps às vezes embrulha o link em /url?q=<destino>
function limparUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('google.') && u.pathname === '/url') return u.searchParams.get('q') || '';
    return url;
  } catch {
    return '';
  }
}

// Site quebrado (não responde / 404 / 5xx) ou que redireciona para um host genérico
async function siteRuim(url) {
  if (hostGenerico(url)) return true;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA } });
    return r.status === 404 || r.status === 410 || r.status >= 500 || hostGenerico(r.url);
  } catch {
    return true;
  }
}

function ehInstagram(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am';
  } catch {
    return false;
  }
}

function telefoneValido(tel) {
  const d = (tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  return d.length === 10 || d.length === 11 ? d : null;
}

function cidadeDoEndereco(endereco) {
  const e = semAcento(endereco);
  return CIDADES.find((c) => e.includes(semAcento(c))) || null;
}

const prioritarios = []; // sem site ou com site quebrado/genérico
const reserva = []; // com site funcional, só usados se faltar lead
const vistos = new Set(); // telefones e nome+cidade já aceitos
const locaisVisitados = new Set();

function salvar() {
  const leads = [...prioritarios, ...reserva].slice(0, META);
  fs.writeFileSync(ARQUIVO, JSON.stringify(leads, null, 2));
  return leads;
}

async function novaPagina(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'pt-BR,pt;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const tipo = req.resourceType();
    const url = req.url();
    const bloquear =
      ['image', 'font', 'media', 'ping'].includes(tipo) ||
      (tipo === 'stylesheet' && process.env.MANTER_CSS !== '1') ||
      /\/maps\/vt|\/kh\?|googleusercontent\.com|gstatic\.com\/.*\.(png|jpg|svg|woff2?)|doubleclick|google-analytics|\/log204|\/gen_204/.test(url);
    if (bloquear) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  return page;
}

async function aceitarConsentimento(page) {
  if (!page.url().includes('consent.google')) return;
  const botao = await page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"], form[action*="save"] button');
  if (botao) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), botao.click()]);
  }
}

// Pesquisa nicho+cidade, rola o painel e devolve os cartões encontrados
async function listarResultados(page, nicho, cidade) {
  const termo = `${nicho} em ${cidade} RJ`;
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(termo)}?hl=pt-BR`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await aceitarConsentimento(page);
  await page.waitForSelector('div[role="feed"], h1.DUwDvf', { timeout: 20000 }).catch(() => {});

  if (!(await page.$('div[role="feed"]'))) {
    // Resultado único: o Maps abre direto a ficha do local
    return (await page.$('h1.DUwDvf')) ? [{ href: page.url(), nome: '', site: '' }] : [];
  }

  let anterior = 0;
  let parado = 0;
  for (let i = 0; i < MAX_ROLAGENS && parado < 3; i++) {
    const { total, fim } = await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      const cartoes = feed.querySelectorAll('a.hfpxzc');
      feed.scrollTop = feed.scrollHeight;
      if (cartoes.length) cartoes[cartoes.length - 1].scrollIntoView();
      return { total: cartoes.length, fim: /final da lista|end of the list/i.test(feed.innerText) };
    });
    if (fim) break;
    parado = total === anterior ? parado + 1 : 0;
    anterior = total;
    await dormir(900);
  }

  return page.evaluate(() =>
    [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].map((a) => {
      const cartao = a.closest('div.Nv2PK') || a.parentElement;
      const site = cartao.querySelector('a.lcr4fd, a[data-value="Website"], a[data-value="Site"]');
      return { href: a.href, nome: a.getAttribute('aria-label') || '', site: site ? site.href : '' };
    })
  );
}

async function extrairLocal(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1.DUwDvf', { timeout: 15000 });
  await page
    .waitForSelector('[data-item-id^="phone:tel:"], [data-item-id="address"]', { timeout: 4000 })
    .catch(() => {});
  return page.evaluate(() => {
    const rotulo = (el) => (el ? (el.getAttribute('aria-label') || el.innerText || '').replace(/^[^:]+:\s*/, '').trim() : '');
    const tel = document.querySelector('[data-item-id^="phone:tel:"]');
    const site = document.querySelector('a[data-item-id="authority"]');
    // Instagram listado noutro ponto da ficha (ex.: secção de perfis na web)
    const instagram = document.querySelector('div[role="main"] a[href*="instagram.com"]');
    return {
      nome: (document.querySelector('h1.DUwDvf')?.innerText || '').trim(),
      telefone: tel ? rotulo(tel) || tel.getAttribute('data-item-id').replace('phone:tel:', '') : '',
      endereco: rotulo(document.querySelector('[data-item-id="address"]')),
      siteUrl: site ? site.href : '',
      instagramUrl: instagram ? instagram.href : '',
      mapsUrl: location.href,
    };
  });
}

// Esquema final gravado no leads.json
function montarLead({ nome, nicho, cidade, telefone, digitos, endereco, mapsUrl, siteUrl, instagramUrl, temSite }) {
  return {
    title: nome,
    subTitle: null,
    description: null,
    ownerDescription: null,
    price: null,
    categoryName: nicho,
    address: endereco,
    neighborhood: null,
    street: null,
    city: cidade,
    postalCode: null,
    state: 'Rio de Janeiro',
    countryCode: 'BR',
    phone: telefone,
    phoneUnformatted: digitos,
    claimThisBusiness: true,
    location: { lat: null, lng: null },
    locatedIn: null,
    floor: null,
    plusCode: null,
    menu: null,
    servicesLink: null,
    totalScore: null,
    permanentlyClosed: false,
    temporarilyClosed: false,
    placeId: null,
    categories: [nicho],
    fid: null,
    cid: null,
    reviewsCount: 0,
    reviewsDistribution: { oneStar: 0, twoStar: 0, threeStar: 0, fourStar: 0, fiveStar: 0 },
    imagesCount: 0,
    imageCategories: [],
    scrapedAt: new Date().toISOString(),
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
    openingHours: [],
    mapsUrl,
    siteUrl,
    instagramUrl,
    temSite,
  };
}

// Visita a ficha e classifica o lead. Devolve true se entrou nos prioritários.
async function processar(page, candidato, nicho, cidadeBusca) {
  const id = (candidato.href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/) || [])[1] || candidato.href;
  if (locaisVisitados.has(id)) return false;
  locaisVisitados.add(id);

  let dados;
  try {
    dados = await extrairLocal(page, candidato.href);
  } catch {
    return false;
  }

  const nome = dados.nome || candidato.nome;
  const digitos = telefoneValido(dados.telefone);
  if (!nome || !digitos) return false;

  // Descarta resultados de cidades vizinhas que o Maps mistura na busca
  const cidade = dados.endereco ? cidadeDoEndereco(dados.endereco) : cidadeBusca;
  if (!cidade) return false;

  const chaveNome = `${semAcento(nome)}|${semAcento(cidade)}`;
  if (vistos.has(digitos) || vistos.has(chaveNome)) return false;
  vistos.add(digitos).add(chaveNome);

  // Link de Instagram no campo de website não é site: vai para instagramUrl
  const link = limparUrl(dados.siteUrl);
  const siteUrl = link && !ehInstagram(link) ? link : null;
  const instagramUrl = (ehInstagram(link) ? link : limparUrl(dados.instagramUrl)) || null;
  // Só conta como site um domínio próprio (redes sociais, WhatsApp, encurtadores etc. não contam)
  const temSite = Boolean(siteUrl) && !hostGenerico(siteUrl);
  const lead = montarLead({
    nome,
    nicho,
    cidade,
    telefone: dados.telefone,
    digitos,
    endereco: dados.endereco,
    mapsUrl: dados.mapsUrl || candidato.href,
    siteUrl,
    instagramUrl,
    temSite,
  });

  if (!temSite || (await siteRuim(siteUrl))) {
    prioritarios.push(lead);
    const motivo = temSite ? 'site quebrado' : instagramUrl ? 'só Instagram' : siteUrl ? 'link genérico' : 'sem site';
    console.log(`  [${prioritarios.length}/${META}] ${nome} — ${lead.phone} (${motivo})`);
    return true;
  }
  reserva.push(lead);
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--lang=pt-BR',
    ],
  });
  process.on('SIGINT', async () => {
    salvar();
    await browser.close().catch(() => {});
    process.exit(130);
  });

  const inicio = Date.now();
  const comSitePendentes = []; // cartões com site próprio, visitados só se faltar lead
  try {
    const page = await novaPagina(browser);

    busca: for (const nicho of NICHOS) {
      for (const cidade of CIDADES) {
        let cartoes = [];
        try {
          cartoes = await listarResultados(page, nicho, cidade);
        } catch (e) {
          console.log(`! Falha na busca "${nicho}" em ${cidade}: ${e.message}`);
          continue;
        }
        // Sem site (ou só rede social) primeiro; os demais ficam para o fim
        const semSite = cartoes.filter((c) => !c.site || hostGenerico(limparUrl(c.site)));
        const comSite = cartoes.filter((c) => !semSite.includes(c));
        comSitePendentes.push(...comSite.map((c) => ({ ...c, nicho, cidade })));
        console.log(`\n> "${nicho}" em ${cidade}: ${cartoes.length} resultados (${semSite.length} sem site próprio)`);

        for (const c of semSite) {
          await processar(page, c, nicho, cidade);
          if (prioritarios.length >= META) break busca;
        }
        salvar();
      }
    }

    // Faltou lead sem site: completa com os que têm site (os quebrados entram como prioritários)
    if (prioritarios.length < META) {
      console.log(`\n> Completando com estabelecimentos que têm site (${comSitePendentes.length} pendentes)...`);
      for (const c of comSitePendentes) {
        if (prioritarios.length + reserva.length >= META) break;
        await processar(page, c, c.nicho, c.cidade);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const leads = salvar();
  const semSite = leads.filter((l) => !l.temSite).length;
  console.log(`\n${leads.length} leads salvos em ${ARQUIVO} (${semSite} sem site) em ${Math.round((Date.now() - inicio) / 1000)}s`);
  if (leads.length < META) console.log(`Atenção: só foram encontrados ${leads.length} leads válidos, abaixo da meta de ${META}.`);
})().catch((e) => {
  console.error('Erro fatal:', e);
  salvar();
  process.exit(1);
});
