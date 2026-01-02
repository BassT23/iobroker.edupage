'use strict';

const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

class EdupageHttp {
  constructor({ baseUrl, log }) {
    this.baseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
    this.log = log;

    this.jar = new CookieJar();

    // IMPORTANT:
    // We disable automatic redirects and follow them manually, so Set-Cookie headers
    // from intermediate 302/303 responses are reliably stored in the cookie jar.
    this.http = wrapper(
      axios.create({
        baseURL: this.baseUrl,
        jar: this.jar,
        withCredentials: true,
        timeout: 25000,
        headers: {
          'User-Agent': 'ioBroker.edupage/0.0.3',
          Accept: 'application/json, text/plain, */*',
        },
        validateStatus: (s) => s >= 200 && s < 400, // allow 3xx
        maxRedirects: 0, // MANUAL redirect handling
      })
    );
  }

  _fmtErr(e) {
    const status = e?.response?.status;
    const url = e?.config?.baseURL ? (e.config.baseURL + (e.config.url || '')) : (e?.config?.url || '');
    if (status) return `HTTP ${status} on ${e?.config?.method?.toUpperCase?.() || ''} ${url}`.trim();
    return e?.message || String(e);
  }

  _isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  _resolveLocation(currentUrl, location) {
    if (!location) return '';
    if (/^https?:\/\//i.test(location)) return location;
    // location may be absolute-path or relative
    if (location.startsWith('/')) return location;
    // relative path: resolve against currentUrl path
    const base = currentUrl.split('?')[0];
    const idx = base.lastIndexOf('/');
    return (idx >= 0 ? base.slice(0, idx + 1) : '/') + location;
  }

  async _requestFollow(method, url, { data, headers, timeout } = {}) {
    let currentUrl = url;
    let currentMethod = method;
    let currentData = data;

    const maxHops = 8;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await this.http.request({
        method: currentMethod,
        url: currentUrl,
        data: currentData,
        headers,
        timeout: timeout ?? 25000,
        maxRedirects: 0, // ensure manual
        validateStatus: (s) => s >= 200 && s < 400,
      });

      // follow redirects manually to ensure cookies from every hop are stored
      if (this._isRedirect(res.status)) {
        const loc = res.headers?.location;
        if (!loc) return res;

        const nextUrl = this._resolveLocation(currentUrl, loc);

        // Browser behavior: 303 (and often 302) turns POST into GET
        if (res.status === 303 || (res.status === 302 && currentMethod !== 'get')) {
          currentMethod = 'get';
          currentData = undefined;
        }

        currentUrl = nextUrl;
        continue;
      }

      return res;
    }

    throw new Error(`Too many redirects while requesting ${url}`);
  }

  async get(url, options = {}) {
    try {
      const res = await this._requestFollow('get', url, {
        headers: options.headers,
        timeout: options.timeout,
      });
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }

  async postJson(url, data, options = {}) {
    try {
      const res = await this._requestFollow('post', url, {
        data,
        headers: {
          ...(options.headers || {}),
          'Content-Type': 'application/json; charset=UTF-8',
        },
        timeout: options.timeout,
      });
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }

  async postJsonRaw(url, data, options = {}) {
    const res = await this.http.post(url, data, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'Content-Type': 'application/json; charset=UTF-8',
      },
    });
    return { data: res.data, status: res.status, headers: res.headers };
  }

  async postForm(url, formObj, options = {}) {
    try {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(formObj || {})) body.append(k, String(v));

      const res = await this._requestFollow('post', url, {
        data: body.toString(),
        headers: {
          ...(options.headers || {}),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
        },
        timeout: options.timeout,
      });
      return res.data;
    } catch (e) {
      throw new Error(this._fmtErr(e));
    }
  }
}

module.exports = { EdupageHttp };
