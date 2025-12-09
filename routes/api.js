'use strict';

const MongoClient = require('mongodb').MongoClient;
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

module.exports = function (app) {

  function anonymizeIp(ip) {
    if (!ip) return null;
    return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  }

  async function fetchStockPrice(ticker) {
    try {
      const url = `https://stock-price-checker-proxy.freecodecamp.rocks/v1/stock/${ticker}/quote`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data || !data.latestPrice) return null;
      return Number(data.latestPrice);
    } catch (err) {
      return null;
    }
  }

  app.route('/api/stock-prices')
    .get(async function (req, res) {
      if (!req.query.stock) {
        return res.json({ error: 'stock is required' });
      }

      let stocks = req.query.stock;
      const like = req.query.like === 'true';
      if (!Array.isArray(stocks)) stocks = [stocks];
      if (stocks.length > 2) return res.json({ error: 'only 1 or 2 stocks supported' });

      stocks = stocks.map(s => ('' + s).toUpperCase());
      const hashedIp = anonymizeIp(req.ip);

      MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }, async (err, client) => {
        if (err || !client) return res.json({ error: 'database error' });
        const db = client.db();
        const collection = db.collection('stocks');

        const getStockData = async (ticker) => {
          const update = { $setOnInsert: { stock: ticker, likes: [] } };
          if (like && hashedIp) update.$addToSet = { likes: hashedIp };

          const result = await collection.findOneAndUpdate(
            { stock: ticker },
            update,
            { upsert: true, returnOriginal: false } // <--- FCC requiere returnOriginal
          );

          const doc = result.value || { stock: ticker, likes: [] };
          const price = await fetchStockPrice(ticker);
          const likesCount = Array.isArray(doc.likes) ? doc.likes.length : 0;

          return { stock: ticker, price: price || 0, likes: likesCount };
        };

        if (stocks.length === 1) {
          const data = await getStockData(stocks[0]);
          client.close();
          return res.json({ stockData: data });
        } else {
          const data1 = await getStockData(stocks[0]);
          const data2 = await getStockData(stocks[1]);

          const out = [
            { stock: data1.stock, price: data1.price, rel_likes: data1.likes - data2.likes },
            { stock: data2.stock, price: data2.price, rel_likes: data2.likes - data1.likes }
          ];

          client.close();
          return res.json({ stockData: out });
        }
      });
    });
};
