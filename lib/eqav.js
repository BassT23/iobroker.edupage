'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

function sha1hex(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

function b64encode(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return buf.toString('base64');
}

function b64decodeToString(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Build Edupage "eq" wrapper body.
 * Mirrors:
 *  - useZip = eqav % 2 == 1
 *  - cs0 = 'dz:'+btoa(deflateRaw(cs))  OR base64(cs)
 *  - eqacs = sha1(cs0)
 *  - eqaz = useEncryption ? '1' : '0'
 */
function buildEqBody(formEncodedString, { eqav = 1, maxEqav = 7, useEncryption = true } = {}) {
  const useZip = (eqav % 2) === 1;

  let eqap;
  if (useZip) {
    const compressed = zlib.deflateRawSync(Buffer.from(formEncodedString, 'utf8'));
    eqap = 'dz:' + b64encode(compressed);
  } else {
    eqap = b64encode(formEncodedString);
  }

  return {
    eqap,
    eqacs: sha1hex(eqap),
    eqaz: useEncryption ? '1' : '0',
    eqav,
    maxEqav,
    useZip,
  };
}

/**
 * Unwrap response: if useEncryption and response starts with "eqz:"
 * then Base64.decode(payload, true)
 */
function unwrapEqResponseText(respText, { useEncryption = true } = {}) {
  if (!useEncryption) return respText;
  if (typeof respText !== 'string') return respText;
  if (!respText.startsWith('eqz:')) return respText;
  return b64decodeToString(respText.slice(4));
}

module.exports = {
  buildEqBody,
  unwrapEqResponseText,
};