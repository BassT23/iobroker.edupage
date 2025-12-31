'use strict';

const qs = require('qs'); // already common; if you prefer, use URLSearchParams
const { buildEqBody, unwrapEqResponseText } = require('./eqav');

async function edupagePost(http, baseUrl, path, dataObj, {
  eqav = 1,
  maxEqav = 7,
  useEncryption = true,
  responseType = 'text', // 'text' first, then JSON.parse if needed
} = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}${path.includes('?') ? '&' : '?'}eqav=${eqav}&maxEqav=${maxEqav}`;

  // This is the "cs" in their JS: $.param(data)
  const formEncoded = qs.stringify(dataObj, { arrayFormat: 'indices' });

  const eq = buildEqBody(formEncoded, { eqav, maxEqav, useEncryption });

  // Send as application/x-www-form-urlencoded with eqap/eqacs/eqaz
  const res = await http.post(url, qs.stringify({
    eqap: eq.eqap,
    eqacs: eq.eqacs,
    eqaz: eq.eqaz,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    responseType: 'text',
    transformResponse: r => r, // keep raw string
    validateStatus: s => s >= 200 && s < 300,
  });

  const text = unwrapEqResponseText(res.data, { useEncryption });

  if (responseType === 'json') {
    // sometimes it’s already JSON, sometimes it’s decoded JSON string
    return JSON.parse(text);
  }
  return text;
}

module.exports = { edupagePost };
