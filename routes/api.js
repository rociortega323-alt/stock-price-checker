'use strict';

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ---------- GLOBAL DATABASE CONNECTION ----------
let db = null;

async function getDb() {
  if (db) return db;

  const client = await MongoClient.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  db = client.db();
  return db;
}

// ---------- HELPERS ----------
function anonymizeIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function fetchStockPrice(ticker) {
  try {
    // FCC proxy para evitar CORS
    const url = `https://stock-price-checker-proxy.freecodecamp.rocks/v1/stock/${ticker}/quote`;

    // Timeout manual
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const data = await res.json();

    // Si el proxy no devuelve price, intenta Alpha Vantage
    if (!data || !data.latestPrice) {
      const alphaUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${process.env.ALPHA_KEY}`;
      const alphaRes = await fetch(alphaUrl);
      const alphaData = await alphaRes.json();
      const price = alphaData?.['Global Quote']?.['05. price'];
      if (!price) return 0;
      return Number(price);
    }

    return Number(data.latestPrice);
  } catch (_) {
    return 0;
  }
}

module.exports = function (app) {

  app.route('/api/stock-prices')
    .get(async (req, res) => {

      if (!req.query.stock) {
        return res.json({ error: 'stock is required' });
      }

      let stocks = req.query.stock;
      const like = req.query.like === 'true';
      const hashedIp = anonymizeIp(req.ip);

      if (!Array.isArray(stocks)) stocks = [stocks];
      if (stocks.length > 2) return res.json({ error: 'only 1 or 2 stocks supported' });

      stocks = stocks.map(s => ('' + s).toUpperCase());

      const db = await getDb();
      const collection = db.collection('stocks');

      async function getStock(ticker) {
        // Paso 1: Crear documento si no existe
        await collection.updateOne(
          { stock: ticker },
          { $setOnInsert: { stock: ticker, likes: [] } },
          { upsert: true }
        );

        // Paso 2: Agregar like si corresponde
        if (like && hashedIp) {
          await collection.updateOne(
            { stock: ticker },
            { $addToSet: { likes: hashedIp } }
          );
        }

        // Recuperar el documento actualizado
        const doc = await collection.findOne({ stock: ticker });
        const likes = Array.isArray(doc.likes) ? doc.likes.length : 0;
        const price = await fetchStockPrice(ticker);

        return {
          stock: ticker,
          price,
          likes
        };
      }

      // ---------- UN STOCK ----------
      if (stocks.length === 1) {
        const data = await getStock(stocks[0]);
        return res.json({ stockData: data });
      }

      // ---------- DOS STOCKS ----------
      const s1 = await getStock(stocks[0]);
      const s2 = await getStock(stocks[1]);

      const relLikes1 = s1.likes - s2.likes;
      const relLikes2 = s2.likes - s1.likes;

      return res.json({
        stockData: [
          { stock: s1.stock, price: s1.price, rel_likes: relLikes1 },
          { stock: s2.stock, price: s2.price, rel_likes: relLikes2 }
        ]
      });

    });

};
