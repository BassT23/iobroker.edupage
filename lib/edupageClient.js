'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const baseUrl = (http?.baseUrl || '').trim();
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || ''; // do not log
  }

  baseUrlNoSlash() {
    return (this.http?.baseUrl || '').replace(/\/+$/, '');
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

  // Browser referer for timetable API:
  getDashboardTimetableRefererPath() {
    return '/dashboard/eb.php?mode=timetable';
  }

  async logCookieNames(tag = '') {
    try {
      const jar = this.http?.jar;
      if (!jar?.getCookies) return;
      const cookies = await jar.getCookies(this.baseUrlNoSlash());
      const names = cookies.map(c => c.key).sort();
      this.log.info(`Cookies${tag ? ' ' + tag : ''}: ${names.join(', ')}`);
    } catch {
      // ignore
    }
  }

  /**
   * Warmup flow closer to browser:
   * 1) GET /
   * 2) GET /dashboard/
   * 3) GET /dashboard/eb.php?mode=timetable
   *
   * Note: we accept guPath for compatibility with main.js, but the browser referer is fixed.
   */
  async warmUpTimetable({ guPath } = {}) {
    const baseUrl = this.baseUrlNoSlash();
    const rootRef = `${baseUrl}/`;
    const dashRef = `${baseUrl}/dashboard/`;

    // 1) root
    await this.http
      .get('/', {
        headers: { Accept: 'text/html,*/*' },
      })
      .catch(() => {});

    // 2) dashboard index
    await this.http
      .get('/dashboard/', {
        headers: { Accept: 'text/html,*/*', Referer: rootRef },
      })
      .catch(() => {});

    // 3) timetable view page (browser-style)
    const p = this.getDashboardTimetableRefererPath();

    await this.http
      .get(p, {
        headers: { Accept: 'text/html,*/*', Referer: dashRef },
      })
      .catch(() => {});

    // optional: if caller provided a different guPath (legacy), warm it too (but do not fail)
    if (guPath && typeof guPath === 'string' && guPath !== p) {
      await this.http
        .get(guPath, {
          headers: { Accept: 'text/html,*/*', Referer: dashRef },
        })
        .catch(() => {});
    }

    await this.logCookieNames('[after warmup]');
  }

  /**
   * IMPORTANT:
   * Do NOT try to scrape _gsh anymore for now.
   * EduPage can return the "wrong" gsh from HTML; user-provided one is the reliable source.
   */
  async getGsh() {
    throw new Error('Auto _gsh disabled. Please set _gsh in adapter config from DevTools (8 hex).');
  }

  // EXACT browser endpoint:
  getCurrentTtPath() {
    return '/timetable/server/currenttt.js?__func=curentttGetData';
  }

  /**
   * EXACT browser payload keys:
   * Browser sends {"__args":[...],"__gsh":"...."}
   */
  async currentttGetData({ args, gsh, guPath } = {}) {
    // always warmup (creates cookies + context)
    await this.warmUpTimetable({ guPath });

    const payload = {
      __args: args,
      __gsh: gsh,
    };

    const baseUrl = this.baseUrlNoSlash();
    const referer = baseUrl + this.getDashboardTimetableRefererPath();

    const headers = {
    Accept: '*/*',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: referer,
    Origin: baseUrl,
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    };

    const raw = await this.http.postJsonRaw(this.getCurrentTtPath(), payload, { timeout: 25000, headers });
    return raw;
  }
}

module.exports = { EdupageClient };
