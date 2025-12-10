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
    const url = `https://stock-price-checker-proxy.freecodecamp.rocks/v1/stock/${ticker}/quote`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const data = await res.json();
    if (!data || !data.latestPrice) return null;

    return Number(data.latestPrice);
  } catch (_) {
    return null;
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
        // Obtener o crear documento
        let doc = await collection.findOne({ stock: ticker });
        if (!doc) {
          await collection.insertOne({ stock: ticker, likes: [] });
          doc = await collection.findOne({ stock: ticker });
        }

        // Actualizar likes si corresponde
        if (like && hashedIp && !doc.likes.includes(hashedIp)) {
          await collection.updateOne(
            { stock: ticker },
            { $push: { likes: hashedIp } }
          );
          doc.likes.push(hashedIp);
        }

        // Obtener precio actual
        const price = await fetchStockPrice(ticker);

        return {
          stock: ticker,
          price: price ?? 0,
          likes: doc.likes.length
        };
      }

      // ---------- PROCESAR TODOS LOS STOCKS EN PARALELO ----------
      const stockDocs = await Promise.all(stocks.map(t => getStock(t)));

      if (stockDocs.length === 1) {
        return res.json({ stockData: stockDocs[0] });
      } else {
        const relLikes1 = stockDocs[0].likes - stockDocs[1].likes;
        const relLikes2 = stockDocs[1].likes - stockDocs[0].likes;

        return res.json({
          stockData: [
            { stock: stockDocs[0].stock, price: stockDocs[0].price, rel_likes: relLikes1 },
            { stock: stockDocs[1].stock, price: stockDocs[1].price, rel_likes: relLikes2 }
          ]
        });
      }
    });

};
