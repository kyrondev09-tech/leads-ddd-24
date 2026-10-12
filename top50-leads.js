const fs = require('fs');
const path = require('path');

const ENTRADA = path.join(__dirname, 'leads.json');
const SAIDA = path.join(__dirname, 'top50_leads.json');
const TOP = 50;
const NICHOS_PRIORITARIOS = ['oficina mecanica', 'dentista', 'energia solar'];

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function pontuar(lead) {
  let score = 0;
  // Oportunidade digital: sem site próprio (temSite já ignora Instagram/Facebook/WhatsApp)
  if (!lead.temSite) score += 40;
  // Prova social / movimento
  if ((lead.reviewsCount ?? 0) >= 15) score += 20;
  if ((lead.totalScore ?? 0) >= 4.5) score += 10;
  // Canal direto: telemóvel do DDD 24 (24 + 9 dígitos começados por 9)
  if (/^249\d{8}$/.test(lead.phoneUnformatted || '')) score += 20;
  // Ticket médio
  if (NICHOS_PRIORITARIOS.includes(semAcento(lead.categoryName))) score += 10;
  return score;
}

const leads = JSON.parse(fs.readFileSync(ENTRADA, 'utf8'));
// Desempate entre scores iguais: mais avaliações primeiro, depois melhor nota
const ordenados = leads
  .map((lead) => ({ ...lead, score: pontuar(lead) }))
  .sort((a, b) => b.score - a.score || (b.reviewsCount ?? 0) - (a.reviewsCount ?? 0) || (b.totalScore ?? 0) - (a.totalScore ?? 0));
const top = ordenados.slice(0, TOP);

fs.writeFileSync(SAIDA, JSON.stringify(top, null, 2));

const distribuicao = {};
for (const l of ordenados) distribuicao[l.score] = (distribuicao[l.score] || 0) + 1;
console.log(`${leads.length} leads pontuados; top ${top.length} gravados em ${SAIDA}`);
console.log('Leads por score (base completa):', distribuicao);
console.log(`Score do top ${top.length}: de ${top[0].score} a ${top[top.length - 1].score}`);
