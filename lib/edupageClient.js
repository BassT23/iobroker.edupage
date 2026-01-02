'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const m = (http?.baseUrl || '').match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || '';
  }

  async getLoginData() {
    return await this.http.get('/login/?cmd=MainLogin&akcia=getData');
  }

  async rpcMainLogin(method, params, options = {}) {
    const url = `/login/?cmd=MainLogin${method ? `&akcia=${encodeURIComponent(method)}` : ''}`;
    return await this.http.postForm(url, { rpcparams: JSON.stringify(params || {}) }, options);
  }

  async getToken({ username, edupage }) {
    return await this.rpcMainLogin('getToken', { username, edupage });
  }

  async login({ username, password, userToken, edupage, ctxt, tu, gu, au }) {
    return await this.rpcMainLogin(
      'login',
      {
        username,
        password,
        userToken,
        edupage,
        ctxt: ctxt || '',
        tu: tu ?? null,
        gu: gu ?? null,
        au: au ?? null,
      },
      { timeout: 25000 }
    );
  }

  getTimetableRefererPath() {
    const eqa = Buffer.from('mode=timetable').toString('base64');
    return `/dashboard/eb.php?eqa=${encodeURIComponent(eqa)}`;
  }

  async warmUpTimetable() {
    const refPath = this.getTimetableRefererPath();
    await this.http.get(refPath, { headers: { Accept: 'text/html,*/*' } }).catch(() => null);
    await this.http.get('/timetable/', { headers: { Accept: 'text/html,*/*' } }).catch(() => null);
  }

  /**
   * Robust: wenn gshOverride gegeben, wird der verwendet.
   * Sonst versuchen wir weiterhin HTML/JS zu parsen.
   */
  async getGsh({ gshOverride } = {}) {
    if (gshOverride && /^[0-9a-f]{8}$/i.test(String(gshOverride))) {
      return String(gshOverride).toLowerCase();
    }

    const tryUrls = [
      this.getTimetableRefererPath(),
      '/timetable/',
      '/timetable',
    ];

    for (const u of tryUrls) {
      try {
        const html = await this.http.get(u, { headers: { Accept: 'text/html,*/*' } });
        const s = typeof html === 'string' ? html : JSON.stringify(html);

        const m =
          s.match(/["_']_gsh["_']\s*:\s*["']([0-9a-f]+)["']/i) ||
          s.match(/_gsh\s*=\s*["']([0-9a-f]+)["']/i);

        if (m?.[1]) return m[1].toLowerCase();
      } catch {
        // ignore
      }
    }

    throw new Error('Could not detect _gsh automatically. Please copy it from DevTools and put it into adapter settings.');
  }

  async currentttGetData({ args, gsh }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    const refPath = this.getTimetableRefererPath();
    const origin = this.http.baseUrl.replace(/\/+$/, '');
    const referer = origin + refPath;

    return await this.http.postJson('/timetable/server/currentttjs?_func=currentttGetData', payload, {
      timeout: 25000,
      headers: {
        Accept: 'application/json,*/*',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: origin,
        Referer: referer,
      },
    });
  }
}

module.exports = { EdupageClient };
