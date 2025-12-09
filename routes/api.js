'use strict';

const MongoClient = require('mongodb').MongoClient;
const request = require('request');
const crypto = require('crypto');

module.exports = function (app) {

  // Helper: anonymize IP by hashing
  function anonymizeIp(ip) {
    if (!ip) return null;
    // crea un hash y toma los primeros 16 chars para espacio menor
    return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
  }

  // Helper: fetch price from FCC proxy
  function fetchPrice(symbol, cb) {
    // usar el proxy que provee FCC para evitar keys
    const url = 'https://stock-price-checker-proxy.freecodecamp.rocks/v1/stock?symbol=' + encodeURIComponent(symbol);
    request(url, { timeout: 5000 }, function (err, resp, body) {
      if (err) return cb(err);
      try {
        const data = JSON.parse(body);
        // El proxy responde con { symbol: 'GOOG', price: '123.45' } o similar
        const price = (data && data.price) ? Number.parseFloat(data.price) : 0;
        cb(null, price);
      } catch (e) {
        cb(e);
      }
    });
  }

  app.route('/api/stock-prices')
    .get(async function (req, res) {
      try {
        if (req.query.stock === undefined || req.query.stock === '') {
          return res.json({ error: 'stock is required' });
        }

        let stocks = req.query.stock;
        let like = (req.query.like !== undefined && (req.query.like === 'true' || req.query.like === 'on' || req.query.like === '1')) ? true : false;

        if (!Array.isArray(stocks)) {
          stocks = [stocks];
        } else {
          // if array provided, limit to 2 (FCC requirement)
          if (stocks.length > 2) return res.json({ error: 'only 1 or 2 stock is supported' });
        }

        // normalize uppercase
        stocks = stocks.map(s => ('' + s).toUpperCase());

        // anonymize ip
        const hashedIp = anonymizeIp(req.ip || req.connection.remoteAddress);

        // connect to DB
        MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
          if (err || !client) {
            return res.json({ error: 'error' });
          }

          const db = client.db();
          const coll = db.collection('stock');

          // function to upsert a single stock and get likes count
          function upsertStock(symbol, cb) {
            const query = { stock: symbol };
            const update = { $setOnInsert: { stock: symbol } };
            if (like && hashedIp) {
              update['$addToSet'] = { likes: hashedIp };
            }
            coll.findOneAndUpdate(query, update, { upsert: true, returnDocument: 'after' }, function (err, result) {
              if (err) return cb(err);
              const doc = result && result.value ? result.value : { stock: symbol, likes: [] };
              const likesCount = Array.isArray(doc.likes) ? doc.likes.length : 0;
              cb(null, likesCount);
            });
          }

          if (stocks.length === 1) {
            // single stock flow
            const sym = stocks[0];
            upsertStock(sym, function (err, likesCount) {
              if (err) {
                client.close();
                return res.json({ error: 'error' });
              }
              fetchPrice(sym, function (err2, price) {
                client.close();
                if (err2) return res.json({ error: 'error fetching price' });
                return res.json({
                  stockData: {
                    stock: sym,
                    price: price,
                    likes: likesCount
                  }
                });
              });
            });
          } else {
            // two stocks flow
            const sym1 = stocks[0];
            const sym2 = stocks[1];

            // upsert both in parallel
            let likes1, likes2, price1, price2;
            let doneCount = 0;
            function checkDone() {
              if (doneCount === 4) {
                client.close();
                // compute rel_likes: likes1 - likes2 etc.
                const rel1 = likes1 - likes2;
                const rel2 = likes2 - likes1;
                return res.json({
                  stockData: [
                    { stock: sym1, price: price1, rel_likes: rel1 },
                    { stock: sym2, price: price2, rel_likes: rel2 }
                  ]
                });
              }
            }

            upsertStock(sym1, function (err, count) {
              likes1 = err ? 0 : count;
              doneCount++;
              checkDone();
            });
            upsertStock(sym2, function (err, count) {
              likes2 = err ? 0 : count;
              doneCount++;
              checkDone();
            });
            fetchPrice(sym1, function (err, p) {
              price1 = err ? 0 : p;
              doneCount++;
              checkDone();
            });
            fetchPrice(sym2, function (err, p) {
              price2 = err ? 0 : p;
              doneCount++;
              checkDone();
            });
          }

        });

      } catch (e) {
        console.error(e);
        return res.json({ error: 'server error' });
      }
    });

};
