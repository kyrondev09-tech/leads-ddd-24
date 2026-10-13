const fs = require('fs');
const path = require('path');

// Uso: node corrigir-links-maps.js [arquivo.json]
const ARQUIVO = path.resolve(process.argv[2] || path.join(__dirname, 'leads_delivery_24.json'));
// Nomes sob os quais o CRM pode procurar o link do Maps
const CHAVES = ['url', 'link_maps', 'googleMapsUrl'];

const urlValida = (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim());

function linkDoMaps(lead) {
  const existente = CHAVES.map((c) => lead[c]).find(urlValida);
  if (existente) return existente.trim();
  if (lead.cid) return `https://maps.google.com/?cid=${lead.cid}`;
  if (lead.placeId) return `https://www.google.com/maps/search/?api=1&query_place_id=${lead.placeId}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.title + ' ' + (lead.address || lead.city || ''))}`;
}

const leads = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
let atualizados = 0;
for (const lead of leads) {
  const link = linkDoMaps(lead);
  if (CHAVES.every((c) => lead[c] === link)) continue;
  for (const c of CHAVES) lead[c] = link;
  atualizados++;
}
fs.writeFileSync(ARQUIVO, JSON.stringify(leads, null, 2));
console.log(`${atualizados} de ${leads.length} registros atualizados em ${ARQUIVO}`);
