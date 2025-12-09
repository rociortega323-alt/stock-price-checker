'use strict';

const MongoClient = require('mongodb').MongoClient;
const request = require('request');
const crypto = require('crypto');

module.exports = function (app) {

  function anonymizeIp(ip) {
    if (!ip) return null;
    return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  }

  app.route('/api/stock-prices')
    .get(function (req, res) {

      if (!req.query.stock) {
        return res.json({ error: 'stock is required' });
      }

      let stock = req.query.stock;
      const like = req.query.like === 'true';

      // Normalize input
      if (!Array.isArray(stock)) stock = [stock];
      if (stock.length > 2) return res.json({ error: 'only 1 or 2 stocks supported' });

      stock = stock.map(s => ('' + s).toUpperCase());

      const hashedIp = anonymizeIp(req.ip || req.connection?.remoteAddress);

      MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
        if (err || !client) return res.json({ error: 'database error' });

        const db = client.db();
        const collection = db.collection('stocks');

        const getStockData = (ticker, cb) => {
          // ensure likes array exists on insert
          const update = { $setOnInsert: { stock: ticker, likes: [] } };
          if (like && hashedIp) update.$addToSet = { likes: hashedIp };

          collection.findOneAndUpdate(
            { stock: ticker },
            update,
            { upsert: true, returnDocument: 'after' },
            (err, result) => {
              
              if (err) return cb({ error: 'db error' });

              let doc = result && result.value ? result.value : { stock: ticker, likes: [] };

              // Si la base tiene basura, corregirla inmediatamente
              if (!Array.isArray(doc.likes)) {
                doc.likes = [];
                collection.updateOne(
                  { stock: ticker },
                  { $set: { likes: [] } }
                );
              }

const likes = doc.likes.length || 0;



              const url =
  `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${process.env.ALPHA_KEY}`;

request(url, { timeout: 5000 }, (errReq, resp, body) => {
  if (errReq || !body) {
  return cb({ stock: ticker, price: 0, likes: likes });
}

let priceNum = 0;
try {
  const data = JSON.parse(body);
  const rawPrice = data["Global Quote"]?.["05. price"];
  priceNum = Number.parseFloat(rawPrice) || 0;
} catch (e) {
  priceNum = 0;
}

cb({ stock: ticker, price: priceNum, likes: likes });
});

            }
          );
        };

        if (stock.length === 1) {
          getStockData(stock[0], (data) => {
            client.close();
            return res.json({ stockData: data });
          });
        } else {
          // parallelize both requests for speed (but keep simple callback chain)
          getStockData(stock[0], (data1) => {
            getStockData(stock[1], (data2) => {
              // compute rel_likes as numbers
              // calcular rel_likes correctamente usando datos de DB
              const rel1 = data1.likes - data2.likes;
              const rel2 = data2.likes - data1.likes;

              // FCC quiere likes ABSOLUTOS solo cuando es 1 stock,
              // y rel_likes SOLO cuando hay dos stocks.
              // Por eso NO debemos incluir "likes" en este caso.
              const out1 = { 
                stock: data1.stock, 
                price: data1.price, 
                rel_likes: rel1 
              };

              const out2 = { 
                stock: data2.stock, 
                price: data2.price, 
                rel_likes: rel2 
              };


              client.close();
              return res.json({ stockData: [out1, out2] });
            });
          });
        }

      });
    });
};
