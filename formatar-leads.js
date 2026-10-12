const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'leads.json');
const leads = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));

// Evita reconverter (e apagar os dados) se o ficheiro já estiver no novo esquema
if (leads.some((lead) => 'title' in lead && !('nome' in lead))) {
  console.log('leads.json já está no esquema novo; nada a fazer.');
  process.exit(0);
}

const scrapedAt = new Date().toISOString();

const formatados = leads.map((lead) => ({
  title: lead.nome,
  subTitle: null,
  description: null,
  ownerDescription: null,
  price: null,
  categoryName: lead.nicho,
  address: lead.endereco,
  neighborhood: null,
  street: null,
  city: lead.cidade,
  postalCode: null,
  state: 'Rio de Janeiro',
  countryCode: 'BR',
  phone: lead.telefone,
  phoneUnformatted: lead.telefone ? lead.telefone.replace(/\D/g, '') : null,
  claimThisBusiness: true,
  location: {
    lat: null,
    lng: null,
  },
  locatedIn: null,
  floor: null,
  plusCode: null,
  menu: null,
  servicesLink: null,
  totalScore: null,
  permanentlyClosed: false,
  temporarilyClosed: false,
  placeId: null,
  categories: [lead.nicho],
  fid: null,
  cid: null,
  reviewsCount: 0,
  reviewsDistribution: {
    oneStar: 0,
    twoStar: 0,
    threeStar: 0,
    fourStar: 0,
    fiveStar: 0,
  },
  imagesCount: 0,
  imageCategories: [],
  scrapedAt,
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
  temSite: lead.temSite ?? false,
  siteUrl: lead.siteUrl ?? '',
}));

fs.writeFileSync(ARQUIVO, JSON.stringify(formatados, null, 2));
console.log(`${formatados.length} leads convertidos em ${ARQUIVO}`);
