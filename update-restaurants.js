// Haalt restaurants op van Thuisbezorgd en slaat ze op in seed-data.json.
// Draai lokaal: npm run update
// Push daarna naar GitHub zodat Render automatisch redeployt.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Restaurants ophalen van thuisbezorgd.nl...');

const html = execSync(
  'curl -s -L "https://www.thuisbezorgd.nl/bestellen/eten/1812" ' +
  '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ' +
  '-H "Accept: text/html,application/xhtml+xml" ' +
  '-H "Accept-Language: nl-NL,nl;q=0.9"',
  { maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', timeout: 30000 }
);

const match = html.match(/<script[^>]*>(\{"props"[\s\S]*?\})<\/script>/);
if (!match) {
  console.error('Kon geen restaurantdata vinden in de pagina HTML.');
  process.exit(1);
}

const data = JSON.parse(match[1]);
const restaurantData = data.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData;

if (!restaurantData) {
  console.error('Restaurantdata structuur niet gevonden.');
  process.exit(1);
}

const restaurants = [];

for (const [id, r] of Object.entries(restaurantData)) {
  if (!r || !r.name) continue;
  if (r.isDelivery === false && r.isOpenNowForDelivery === false) continue;

  const deliveryTime = r.deliveryOpeningTimeLocal;
  if (deliveryTime) {
    const timePart = deliveryTime.split('T')[1];
    if (timePart) {
      const [hours, minutes] = timePart.split(':').map(Number);
      if (hours * 60 + minutes > 810) continue;
    }
  }

  const cuisines = Array.isArray(r.cuisines)
    ? r.cuisines.map(c => c.name).join(', ')
    : '';

  restaurants.push({
    id: String(r.id || id),
    name: r.name,
    slug: r.uniqueName || '',
    cuisine: cuisines,
    logo_url: r.logoUrl || '',
    rating: r.rating?.starRating || 0,
    rating_count: r.rating?.count || 0,
    delivery_fee: '',
    min_order: '',
    is_open: r.isTemporarilyOffline ? 0 : 1,
  });
}

const seedPath = path.join(__dirname, 'seed-data.json');
fs.writeFileSync(seedPath, JSON.stringify(restaurants, null, 2));
console.log(`${restaurants.length} restaurants opgeslagen in seed-data.json`);
console.log('Push nu naar GitHub: git add seed-data.json && git commit -m "Update restaurants" && git push');
