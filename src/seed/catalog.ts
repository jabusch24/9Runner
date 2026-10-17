// Static catalog vocabulary. Weights are intentionally skewed: a handful of
// categories and brands dominate, like a real store's long tail.

export type CategorySpec = {
  name: string;
  department: string;
  weight: number;
  subcategories: string[];
  noun: string;
  brands: [string, number][];
  priceMedian: number;
  priceSigma: number;
  models: string[];
  features: string[];
  tags: string[];
  sizes?: string[];
  genders?: [string, number][];
  attributes: (r: () => number) => Record<string, unknown>;
};

const SHOE_SIZES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47'];
const APPAREL_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const ADULT_GENDERS: [string, number][] = [['Men', 42], ['Women', 40], ['Unisex', 12], ['Kids', 6]];

const pickFrom = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

export const CATEGORIES: CategorySpec[] = [
  {
    name: 'Running Shoes', department: 'Footwear', weight: 14, noun: 'Running Shoe',
    subcategories: ['Road Running', 'Trail Running', 'Racing', 'Stability'],
    brands: [['Nike', 30], ['Adidas', 24], ['Asics', 16], ['New Balance', 12], ['Brooks', 8], ['Hoka', 7], ['Saucony', 5], ['On', 4], ['Mizuno', 2]],
    priceMedian: 125, priceSigma: 0.32,
    models: ['Pegasus', 'Ultraboost', 'Gel-Nimbus', 'Fresh Foam', 'Ghost', 'Clifton', 'Kinvara', 'Cloudmonster', 'Wave Rider', 'Vaporfly', 'Adizero', 'Novablast', 'Glycerin', 'Speedgoat', 'Endorphin'],
    features: ['responsive foam midsole', 'breathable engineered mesh upper', 'carbon fiber plate', 'durable rubber outsole', 'wide toe box', 'reflective details for night running', 'rock plate for technical trails', 'plush heel cushioning'],
    tags: ['running', 'shoes', 'training', 'marathon', 'road', 'trail', 'cushioned', 'lightweight'],
    sizes: SHOE_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ dropMm: pickFrom(r, [0, 4, 6, 8, 10, 12]), weightG: 180 + Math.round(r() * 160), cushioning: pickFrom(r, ['minimal', 'moderate', 'max']), surface: pickFrom(r, ['road', 'trail', 'track']) }),
  },
  {
    name: 'Sneakers', department: 'Footwear', weight: 10, noun: 'Sneaker',
    subcategories: ['Lifestyle', 'Skate', 'Basketball', 'Retro'],
    brands: [['Nike', 32], ['Adidas', 26], ['Puma', 12], ['New Balance', 10], ['Vans', 9], ['Converse', 8], ['Reebok', 3]],
    priceMedian: 95, priceSigma: 0.35,
    models: ['Air Force', 'Samba', 'Suede', '550', 'Old Skool', 'Chuck 70', 'Club C', 'Dunk', 'Gazelle', 'Jordan', 'Forum', 'Superstar'],
    features: ['premium leather upper', 'vulcanized sole', 'padded collar', 'classic court silhouette', 'suede overlays', 'cupsole construction'],
    tags: ['sneakers', 'shoes', 'casual', 'streetwear', 'retro', 'everyday'],
    sizes: SHOE_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ material: pickFrom(r, ['leather', 'suede', 'canvas', 'synthetic']), closure: pickFrom(r, ['laces', 'slip-on', 'velcro']) }),
  },
  {
    name: 'Hiking Boots', department: 'Footwear', weight: 4, noun: 'Hiking Boot',
    subcategories: ['Day Hiking', 'Backpacking', 'Winter'],
    brands: [['Salomon', 25], ['Merrell', 22], ['The North Face', 15], ['Columbia', 14], ['Lowa', 10], ['Keen', 10], ['Scarpa', 4]],
    priceMedian: 165, priceSigma: 0.3,
    models: ['Quest', 'Moab', 'Renegade', 'Targhee', 'X Ultra', 'Vectiv', 'Newton Ridge', 'Zodiac'],
    features: ['waterproof GORE-TEX membrane', 'Vibram outsole', 'ankle support', 'shock absorbing midsole', 'gusseted tongue'],
    tags: ['hiking', 'boots', 'outdoor', 'waterproof', 'trail', 'trekking'],
    sizes: SHOE_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ waterproof: r() < 0.8, height: pickFrom(r, ['low', 'mid', 'high']) }),
  },
  {
    name: 'Jackets', department: 'Apparel', weight: 8, noun: 'Jacket',
    subcategories: ['Rain Jackets', 'Down Jackets', 'Softshell', 'Running Jackets'],
    brands: [['The North Face', 22], ['Patagonia', 16], ['Columbia', 15], ['Arc\'teryx', 10], ['Nike', 10], ['Adidas', 9], ['Jack Wolfskin', 8], ['Uniqlo', 10]],
    priceMedian: 140, priceSigma: 0.55,
    models: ['Nuptse', 'Torrentshell', 'Beta', 'Nano Puff', 'Windrunner', 'Watertight', 'Atom', 'Essential', 'Storm'],
    features: ['packable design', 'waterproof breathable shell', 'recycled down insulation', 'adjustable hood', 'pit zips for ventilation', 'windproof softshell fabric', 'lightweight running fit'],
    tags: ['jacket', 'outdoor', 'waterproof', 'winter', 'rain', 'running', 'layering'],
    sizes: APPAREL_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ material: pickFrom(r, ['nylon', 'polyester', 'down', 'softshell']), fit: pickFrom(r, ['regular', 'slim', 'relaxed']), waterproofRatingMm: pickFrom(r, [0, 5000, 10000, 20000]) }),
  },
  {
    name: 'T-Shirts', department: 'Apparel', weight: 9, noun: 'T-Shirt',
    subcategories: ['Running Shirts', 'Graphic Tees', 'Basics'],
    brands: [['Nike', 20], ['Adidas', 18], ['Uniqlo', 18], ['Under Armour', 12], ['Puma', 10], ['Patagonia', 6], ['Levi\'s', 16]],
    priceMedian: 28, priceSigma: 0.4,
    models: ['Dri-FIT', 'Essentials', 'Tech', 'Supima', 'Own The Run', 'Classic', 'Heatgear'],
    features: ['moisture wicking fabric', 'organic cotton', 'flatlock seams', 'quick dry', 'reflective logo', 'relaxed fit'],
    tags: ['t-shirt', 'running', 'training', 'cotton', 'casual', 'gym'],
    sizes: APPAREL_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ material: pickFrom(r, ['cotton', 'polyester', 'merino', 'blend']), fit: pickFrom(r, ['regular', 'slim', 'oversized']) }),
  },
  {
    name: 'Running Tights', department: 'Apparel', weight: 3, noun: 'Running Tight',
    subcategories: ['Long Tights', 'Shorts', 'Half Tights'],
    brands: [['Nike', 28], ['Adidas', 20], ['Lululemon', 18], ['Under Armour', 14], ['Asics', 10], ['Gymshark', 10]],
    priceMedian: 55, priceSigma: 0.35,
    models: ['Epic Luxe', 'Fast Tight', 'Swift', 'Speedpocket', 'Vital', 'Run Icon'],
    features: ['zip pocket', 'compressive fit', 'four-way stretch', 'thermal brushed interior', 'reflective trims'],
    tags: ['running', 'tights', 'training', 'gym', 'compression'],
    sizes: APPAREL_SIZES, genders: ADULT_GENDERS,
    attributes: (r) => ({ inseamCm: pickFrom(r, [12, 18, 56, 66, 71]), compression: r() < 0.5 }),
  },
  {
    name: 'Headphones', department: 'Electronics', weight: 7, noun: 'Headphones',
    subcategories: ['Wireless Headphones', 'Earbuds', 'Sports Earbuds', 'Studio'],
    brands: [['Sony', 24], ['Apple', 22], ['Bose', 16], ['Samsung', 12], ['Sennheiser', 8], ['JBL', 12], ['Jabra', 6]],
    priceMedian: 180, priceSigma: 0.6,
    models: ['WH-1000XM', 'AirPods', 'QuietComfort', 'Galaxy Buds', 'Momentum', 'Tune', 'Elite', 'Live'],
    features: ['active noise cancelling', '30 hour battery life', 'sweat resistant for running', 'multipoint bluetooth', 'spatial audio', 'transparency mode'],
    tags: ['headphones', 'wireless', 'bluetooth', 'audio', 'noise cancelling', 'running'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ batteryHours: pickFrom(r, [6, 8, 24, 30, 40]), connectivity: pickFrom(r, ['bluetooth 5.3', 'bluetooth 5.0', 'wired']), anc: r() < 0.6 }),
  },
  {
    name: 'Smartwatches', department: 'Electronics', weight: 5, noun: 'Smartwatch',
    subcategories: ['GPS Running Watches', 'Fitness Trackers', 'Lifestyle Watches'],
    brands: [['Apple', 26], ['Garmin', 24], ['Samsung', 16], ['Polar', 8], ['Suunto', 7], ['Fitbit', 12], ['Coros', 7]],
    priceMedian: 260, priceSigma: 0.55,
    models: ['Forerunner', 'Watch Series', 'Galaxy Watch', 'Vantage', 'Race', 'Charge', 'Pace', 'Fenix'],
    features: ['multi-band GPS', 'heart rate monitoring', 'training load insights', 'sleep tracking', 'two week battery', 'contactless payments'],
    tags: ['smartwatch', 'gps', 'running', 'fitness', 'wearable', 'tracker'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ batteryDays: pickFrom(r, [1, 2, 7, 14, 21]), gps: r() < 0.85, waterResistanceM: pickFrom(r, [30, 50, 100]) }),
  },
  {
    name: 'Laptops', department: 'Electronics', weight: 4, noun: 'Laptop',
    subcategories: ['Ultrabooks', 'Gaming Laptops', 'Business Laptops'],
    brands: [['Apple', 22], ['Lenovo', 20], ['Dell', 18], ['HP', 16], ['Asus', 12], ['Acer', 8], ['Microsoft', 4]],
    priceMedian: 1150, priceSigma: 0.45,
    models: ['MacBook Air', 'ThinkPad', 'XPS', 'Spectre', 'ROG', 'Swift', 'Surface Laptop', 'Zenbook'],
    features: ['all day battery', 'OLED display', 'backlit keyboard', 'Thunderbolt ports', 'dedicated graphics', 'lightweight aluminium chassis'],
    tags: ['laptop', 'computer', 'notebook', 'work', 'gaming', 'portable'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ ramGb: pickFrom(r, [8, 16, 32, 64]), storageGb: pickFrom(r, [256, 512, 1024, 2048]), screenInch: pickFrom(r, [13.3, 14, 15.6, 16]) }),
  },
  {
    name: 'Speakers', department: 'Electronics', weight: 3, noun: 'Speaker',
    subcategories: ['Portable Speakers', 'Smart Speakers', 'Soundbars'],
    brands: [['JBL', 26], ['Bose', 20], ['Sonos', 18], ['Sony', 14], ['Ultimate Ears', 12], ['Marshall', 10]],
    priceMedian: 150, priceSigma: 0.6,
    models: ['Flip', 'SoundLink', 'Era', 'Boom', 'Emberton', 'Charge', 'Beam'],
    features: ['waterproof design', '360 degree sound', 'voice assistant', 'deep bass', 'party mode pairing'],
    tags: ['speaker', 'bluetooth', 'audio', 'portable', 'wireless'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ batteryHours: pickFrom(r, [0, 10, 12, 20, 24]), waterproof: r() < 0.5 }),
  },
  {
    name: 'Coffee Machines', department: 'Home & Kitchen', weight: 3, noun: 'Coffee Machine',
    subcategories: ['Espresso Machines', 'Filter Coffee', 'Capsule Machines'],
    brands: [['De\'Longhi', 26], ['Philips', 18], ['Nespresso', 20], ['Breville', 14], ['Jura', 8], ['Melitta', 14]],
    priceMedian: 320, priceSigma: 0.7,
    models: ['Magnifica', 'Barista', 'Vertuo', 'LatteGo', 'Bambino', 'Caffeo', 'E8'],
    features: ['integrated grinder', 'milk frother', '15 bar pump', 'programmable brew strength', 'quick heat up'],
    tags: ['coffee', 'espresso', 'kitchen', 'appliance', 'barista'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ powerW: pickFrom(r, [1100, 1350, 1450, 1600]), capacityL: pickFrom(r, [1.0, 1.4, 1.8, 2.1]) }),
  },
  {
    name: 'Yoga Mats', department: 'Sports', weight: 2, noun: 'Yoga Mat',
    subcategories: ['Travel Mats', 'Thick Mats', 'Eco Mats'],
    brands: [['Lululemon', 24], ['Manduka', 20], ['Gaiam', 22], ['Adidas', 12], ['Nike', 10], ['Liforme', 12]],
    priceMedian: 60, priceSigma: 0.5,
    models: ['The Mat', 'PRO', 'Premium', 'Essential', 'Flow', 'Grip'],
    features: ['non-slip surface', 'natural rubber', 'alignment markers', 'extra cushioning', 'carry strap'],
    tags: ['yoga', 'fitness', 'mat', 'training', 'pilates'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ thicknessMm: pickFrom(r, [1.5, 3, 4, 5, 6]), material: pickFrom(r, ['natural rubber', 'TPE', 'PVC', 'cork']) }),
  },
  {
    name: 'Backpacks', department: 'Sports', weight: 4, noun: 'Backpack',
    subcategories: ['Hiking Packs', 'Running Vests', 'Daypacks', 'Laptop Backpacks'],
    brands: [['Osprey', 20], ['The North Face', 18], ['Deuter', 14], ['Salomon', 12], ['Herschel', 12], ['Patagonia', 10], ['Fjallraven', 14]],
    priceMedian: 95, priceSigma: 0.5,
    models: ['Talon', 'Borealis', 'Futura', 'ADV Skin', 'Little America', 'Kanken', 'Black Hole'],
    features: ['padded laptop sleeve', 'hydration compatible', 'ventilated back panel', 'water resistant fabric', 'hip belt pockets'],
    tags: ['backpack', 'hiking', 'travel', 'outdoor', 'running', 'commute'],
    genders: [['Unisex', 1]],
    attributes: (r) => ({ volumeL: pickFrom(r, [5, 12, 20, 28, 40, 55]), laptopSleeve: r() < 0.5 }),
  },
];

export const COLORS: [string, number][] = [
  ['Black', 30], ['White', 16], ['Grey', 12], ['Navy', 9], ['Blue', 8], ['Red', 6], ['Green', 5], ['Beige', 4], ['Pink', 3], ['Orange', 3], ['Yellow', 2], ['Purple', 2],
];

/** Per-brand quality bias (adds to rating mean) and price premium. */
export const BRAND_TRAITS: Record<string, { quality: number; premium: number }> = {
  Nike: { quality: 0.1, premium: 1.1 }, Adidas: { quality: 0.05, premium: 1.05 }, Asics: { quality: 0.15, premium: 1.0 }, Hoka: { quality: 0.2, premium: 1.15 },
  On: { quality: 0.1, premium: 1.25 }, Brooks: { quality: 0.2, premium: 1.05 }, Apple: { quality: 0.15, premium: 1.35 }, Sony: { quality: 0.15, premium: 1.1 },
  Bose: { quality: 0.15, premium: 1.2 }, Garmin: { quality: 0.2, premium: 1.15 }, 'Arc\'teryx': { quality: 0.2, premium: 1.6 }, Patagonia: { quality: 0.2, premium: 1.3 },
  Uniqlo: { quality: 0.0, premium: 0.6 }, Acer: { quality: -0.15, premium: 0.8 }, Fitbit: { quality: -0.1, premium: 0.85 }, Gaiam: { quality: -0.1, premium: 0.7 },
  Jura: { quality: 0.15, premium: 2.2 }, Lululemon: { quality: 0.15, premium: 1.3 }, Liforme: { quality: 0.25, premium: 1.6 },
};

export const GENERIC_PHRASES = [
  'Designed for everyday comfort and long lasting durability.',
  'A customer favourite that balances performance and value.',
  'Built with recycled materials as part of our sustainability commitment.',
  'Engineered and tested by athletes.',
  'Perfect for training, travel and weekend adventures.',
  'Upgraded for this season with refined details.',
  'Easy care and machine washable where applicable.',
  'Backed by a two year warranty.',
];

/**
 * Search terms shoppers type, with Zipf-like frequencies. Used by the
 * workload so repeated popular queries dominate, like real search logs.
 */
export const SEARCH_TERMS: [string, number][] = [
  ['running shoes', 40], ['wireless headphones', 22], ['jacket', 20], ['sneakers', 16], ['waterproof jacket', 12],
  ['trail running', 10], ['noise cancelling', 9], ['gps watch', 8], ['hiking boots', 8], ['laptop', 7],
  ['t-shirt', 7], ['backpack', 6], ['espresso', 5], ['yoga mat', 5], ['lightweight', 4],
  ['nike running', 4], ['bluetooth speaker', 3], ['marathon', 3], ['down jacket', 3], ['carbon plate', 2],
];

export const REVIEW_PHRASES = {
  good: ['Absolutely love it', 'Exceeded my expectations', 'Great value for money', 'Fits perfectly', 'Would buy again', 'Super comfortable', 'Excellent quality'],
  mixed: ['Decent but not perfect', 'Does the job', 'Okay for the price', 'Runs a bit small', 'Good but delivery was slow'],
  bad: ['Disappointed', 'Fell apart after a month', 'Not as described', 'Returned it', 'Poor quality control'],
};
