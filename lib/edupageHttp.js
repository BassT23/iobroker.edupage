'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/**
 * EduPage "eqap" wrapper.
 * Browser macht:
 *  - cs = $.param(data)  (also "rpcparams=%7B...%7D")
 *  - (optional) RawDeflate -> Base64, prefix "dz:"
 *  - eqacs = sha1(eqap)
 *  - eqaz = 1 (encryption enabled)  -> response starts with "eqz:" + base64
 *
 * We implement the same: always compress with deflateRaw and always set eqaz=1.
 */
class EdupageHttp {
  /**
   * @param {{ http: any, baseUrl: string, log?: any }} opts
   */
  constructor({ http, baseUrl, log }) {
    this.http = http;
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.log = log;
    this.maxEqav = 7;
  }

  sha1Hex(str) {
    return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
  }

  b64encode(buf) {
    return Buffer.from(buf).toString('base64');
  }

  b64decodeToString(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  /**
   * Build eqap from an URL-encoded string.
   * We always do dz: + base64(deflateRaw(cs)).
   */
  makeEqapFromCs(cs) {
    const raw = Buffer.from(cs, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    return 'dz:' + this.b64encode(deflated);
  }

  /**
   * Decode response:
   * - if it starts with "eqz:" => base64 decode the rest (utf8)
   * - else return as-is
   */
  decodeEqzIfNeeded(data) {
    if (typeof data !== 'string') return data;
    if (!data.startsWith('eqz:')) return data;
    return this.b64decodeToString(data.slice(4));
  }

  /**
   * POST with EduPage eq wrapper + auto retry on eqwd:
   *
   * @param {string} pathWithQuery e.g. "/login/?cmd=MainLogin"
   * @param {string} akcia e.g. "getToken"
   * @param {object} rpcObj params object that will become rpcparams JSON
   * @returns {Promise<any>} parsed JSON
   */
  async rpc(pathWithQuery, akcia, rpcObj) {
    const urlBase = this.baseUrl + pathWithQuery;

    // Browser macht: { rpcparams: JSON.stringify(params) } dann $.param() draus.
    // Das wird später "rpcparams=%7B%22username%22%3A...%7D"
    const rpcparamsJson = JSON.stringify(rpcObj ?? {});
    const cs = `rpcparams=${encodeURIComponent(rpcparamsJson)}`;

    let lastErr = null;

    for (let eqav = 1; eqav <= this.maxEqav; eqav++) {
      const url = `${urlBase}${urlBase.includes('?') ? '&' : '?'}akcia=${encodeURIComponent(akcia)}&eqav=${eqav}&maxEqav=${this.maxEqav}`;

      // choose zip on odd eqav (like browser), but we can always zip; better to mimic:
      const useZip = (eqav % 2) === 1;
      const eqap = useZip ? this.makeEqapFromCs(cs) : Buffer.from(cs, 'utf8').toString('base64'); // fallback mode like browser
      const eqacs = this.sha1Hex(eqap);
      const eqaz = '1'; // useEncryption true

      try {
        const resp = await this.http.post(url, new URLSearchParams({ eqap, eqacs, eqaz }).toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
          },
          // IMPORTANT: axios default transforms might parse json; we want raw string
          transformResponse: [(d) => d],
        });

        let body = resp?.data;

        // some responses might be "eqwd:" marker -> means wrongData, retry with next eqav
        if (typeof body === 'string' && body.startsWith('eqwd:')) {
          if (this.log?.debug) this.log.debug(`EduPage eqwd received -> retry eqav=${eqav + 1}`);
          continue;
        }

        body = this.decodeEqzIfNeeded(body);

        // after decoding, should be JSON for MainLogin RPC
        let parsed;
        try {
          parsed = typeof body === 'string' ? JSON.parse(body) : body;
        } catch (e) {
          // sometimes server replies html (captcha, redirect). give a helpful snippet
          const snippet = (typeof body === 'string') ? body.slice(0, 200) : String(body);
          throw new Error(`RPC parse failed (${akcia}). Snippet: ${snippet}`);
        }

        return parsed;
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error('RPC failed (unknown)');
  }

  /**
   * Simple GET with cookiejar (for later pages like /dashboard/eb.php?mode=timetable)
   */
  async get(path) {
    const url = this.baseUrl + path;
    const resp = await this.http.get(url, { transformResponse: [(d) => d] });
    return resp.data;
  }
}

module.exports = { EdupageHttp };
