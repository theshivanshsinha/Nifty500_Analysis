const https = require('https');
const fs = require('fs');

const url = 'https://archives.nseindia.com/content/indices/ind_nifty500list.csv';
const outputFile = 'data/nifty500.json';

https.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const lines = data.split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      const symbolIdx = headers.findIndex(h => h.toLowerCase() === 'symbol');
      const companyIdx = headers.findIndex(h => h.toLowerCase() === 'company name');
      const industryIdx = headers.findIndex(h => (h.toLowerCase() === 'industry' || h.toLowerCase() === 'sector'));

      const stocks = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const columns = lines[i].split(',').map(c => c.trim());
        if (symbolIdx >= 0 && columns[symbolIdx]) {
           stocks.push({
             symbol: columns[symbolIdx] + '.NS',
             companyName: companyIdx >= 0 ? columns[companyIdx] : columns[symbolIdx],
             sector: industryIdx >= 0 ? columns[industryIdx] : 'Unknown'
           });
        }
      }

      if (!fs.existsSync('data')) {
        fs.mkdirSync('data');
      }
      fs.writeFileSync(outputFile, JSON.stringify(stocks, null, 2));
      console.log('Successfully written ' + stocks.length + ' stocks to ' + outputFile);
    } catch (err) {
      console.error('Error parsing CSV', err);
    }
  });

}).on('error', (err) => {
  console.log('Error fetching Nifty 500 list: ', err.message);
});
