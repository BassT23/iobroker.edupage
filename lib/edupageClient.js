'use strict';

class EdupageClient {
  constructor({ http, log }) {
    this.http = http;
    this.log = log;

    // subdomain automatisch aus baseUrl ableiten: https://myschool.edupage.org -> myschool
    const m = (http?.baseUrl || '').match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    this.school = m?.[1] || '';
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

  // ===== Timetable bootstrap: getTTViewerData (liefert _gsh) =====
  // Browser macht i.d.R.:
  // POST /timetable/server/ttviewerjs?_func=getTTViewerData
  // payload: { args: [null] }
  // Antwort enthält: res.r._gsh
  async getTTViewerData() {
    const res = await this.http.postJson(
      '/timetable/server/ttviewerjs?_func=getTTViewerData',
      { args: [null] },
      {
        timeout: 25000,
        headers: { Accept: 'application/json,*/*' },
      }
    );

    const gsh = res?.r?._gsh;
    if (!gsh) {
      // Debug-Hilfe, falls EduPage es ändert:
      const keys = res && typeof res === 'object' ? Object.keys(res).join(',') : '';
      throw new Error(`No _gsh in getTTViewerData response (keys: ${keys})`);
    }

    return { gsh, raw: res };
  }

  async currentttGetData({ args, gsh }) {
    const payload = { args };
    if (gsh) payload._gsh = gsh;

    // wichtig: referer/origin wie im Browser
    const referer = `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`;

    return await this.http.postJson('/timetable/server/currentttjs?_func=currentttGetData', payload, {
      timeout: 25000,
      headers: {
        'Accept': 'application/json,*/*',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.http.baseUrl,
        'Referer': this.http.baseUrl.replace(/\/+$/, '') + referer,
      },
    });
  }
}

module.exports = { EdupageClient };
