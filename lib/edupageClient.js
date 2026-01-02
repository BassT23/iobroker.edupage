'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    const baseUrl = (http?.baseUrl || '').trim();
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || ''; // do not log
  }

  // ----- Login: getData -----
  async getLoginData() {
    return await this.http.get('/login/?cmd=MainLogin&akcia=getData');
  }

  // AscHttp.rpc Nachbau:
  // POST /login/?cmd=MainLogin&akcia=<method>
  // body: rpcparams=<JSON.stringify(params)> (x-www-form-urlencoded)
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

  // ----- Timetable referer (Option A) -----
  // Das ist der Pfad, den du im Browser auch siehst:
  // /dashboard/eb.php?eqa= (base64 von "mode=timetable")
  getTimetableRefererPath() {
    const eqa = Buffer.from('mode=timetable').toString('base64');
    return `/dashboard/eb.php?eqa=${encodeURIComponent(eqa)}`;
  }

  // ----- Warmup: Timetable-Seite wirklich aufrufen -----
  // Wichtig, damit später /timetable/server/... nicht 404 liefert.
  async warmUpTimetable({ guPath } = {}) {
    const p = guPath || this.getTimetableRefererPath();
    // Seite laden (HTML) – Cookies/Session werden dabei "gesetzt"
    return await this.http.get(p, { headers: { Accept: 'text/html,*/*' } });
  }

  // ----- _gsh holen -----
  // Zuverlässiger: aus der warmup HTML ziehen.
  async getGsh({ guPath } = {}) {
    const html = await this.warmUpTimetable({ guPath });
    const s = typeof html === 'string' ? html : JSON.stringify(html);

    // mehrere Varianten abdecken
    const m =
      s.match(/["_']_gsh["_']\s*:\s*["']([0-9a-f]+)["']/i) ||
      s.match(/\b_gsh\b\s*=\s*["']([0-9a-f]+)["']/i) ||
      s.match(/data-gsh=["']([0-9a-f]+)["']/i);

    if (m?.[1]) return m[1];

    throw new Error('Could not detect _gsh automatically (open timetable in browser once and try again).');
  }

  // ----- Timetable: currentttGetData -----
  // POST JSON: { args: [...], _gsh: "...." }
  // WICHTIG: Referer & Origin mitsenden, sonst 404 möglich.
  async currentttGetData({ args, gsh, guPath }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    const baseUrl = (this.http?.baseUrl || '').replace(/\/+$/, '');
    const refererPath = guPath || this.getTimetableRefererPath();
    const referer = baseUrl + refererPath;
    const origin = baseUrl;

    return await this.http.postJson('/timetable/server/currentttjs?_func=currentttGetData', payload, {
      timeout: 25000,
      headers: {
        Accept: 'application/json,*/*',
        Referer: referer,
        Origin: origin,
      },
    });
  }
}

module.exports = { EdupageClient };
