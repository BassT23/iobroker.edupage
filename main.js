'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const crypto = require('crypto');

class Edupage extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'edupage' });
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.jar = new CookieJar();
    this.http = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': 'ioBroker.edupage/0.0.1',
        'Accept': 'application/json, text/plain, */*'
      }
    }));

    this.timer = null;
    this.maxLessons = 12;
    // Session caching
    this.session = null;
    this.sessionCreatedAt = 0;
    this.sessionMaxAgeMs = 6 * 60 * 60 * 1000; // 6h
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
    if (!this.config.username || !this.config.password) return this.log.error('Please set username/password');

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    await this.ensureStates();

    await this.syncOnce(baseUrl).catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce(baseUrl).catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastHash', 'string', 'Hash of last model'],
      ['meta.changedSinceLastSync', 'boolean', 'Changed since last sync'],
      ['meta.lastError', 'string', 'Last error message'],
      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],
      ['next.when', 'string', 'today|tomorrow'],
      ['next.subject', 'string', 'Next subject'],
      ['next.room', 'string', 'Next room'],
      ['next.teacher', 'string', 'Next teacher'],
      ['next.start', 'string', 'Next start'],
      ['next.end', 'string', 'Next end'],
      ['next.changed', 'boolean', 'Next changed'],
      ['next.canceled', 'boolean', 'Next canceled'],
      ['next.changeText', 'string', 'Next change text']
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {}
      });
    }

    for (const day of ['today', 'tomorrow']) {
      for (let i = 0; i < this.maxLessons; i++) {
        await this.ensureLessonStates(`${day}.lessons.${i}`);
      }
    }
  }

  async ensureLessonStates(base) {
    const defs = [
      ['exists', 'boolean', 'Lesson exists'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text']
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {}
      });
    }
  }

  _getSubdomainFromBaseUrl(baseUrl) {
    const u = new URL(baseUrl);
    const host = u.hostname;
    return host.split('.')[0];
  }

  _extractBetween(haystack, start, end) {
    const s = haystack.indexOf(start);
    if (s === -1) return null;
    const rest = haystack.slice(s + start.length);
    const e = rest.indexOf(end);
    if (e === -1) return null;
    return rest.slice(0, e);
  }

  // ✅ Robust helper: first regex match
  _extractFirstMatch(text, regex, group = 1) {
    const m = String(text || '').match(regex);
    return m ? m[group] : null;
  }

  // ✅ Robust helper: find gpid + gsh in ttday page
  _extractGpidAndGsh(html) {
    const gpid =
      this._extractFirstMatch(html, /[?&]gpid=(\d+)/) ||
      this._extractFirstMatch(html, /\bgpid\s*=\s*(\d+)/) ||
      this._extractFirstMatch(html, /"gpid"\s*:\s*(\d+)/);

    const gsh =
      this._extractFirstMatch(html, /[?&]gsh=([^"&]+)/) ||
      this._extractFirstMatch(html, /\bgsh\s*=\s*"([^"]+)"/) ||
      this._extractFirstMatch(html, /"gsh"\s*:\s*"([^"]+)"/);

    return { gpid, gsh };
  }

  _isSessionValid() {
    if (!this.session) return false;
    if (!this.sessionCreatedAt) return false;
    const age = Date.now() - this.sessionCreatedAt;
    return age < this.sessionMaxAgeMs;
  }

  _resetSession() {
    this.session = null;
    this.sessionCreatedAt = 0;
    this.jar = new CookieJar();
    this.http = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': 'ioBroker.edupage/0.0.1',
        'Accept': 'application/json, text/plain, */*'
      }
    }));
  }

  async ensureSession(baseUrl) {
    // Already valid? Use it.
    if (this._isSessionValid()) return this.session;

    // Recreate jar+client to avoid stale/bad cookies
    this._resetSession();

    // Login once
    const s = await this.edupageLogin(baseUrl, this.config.username, this.config.password);
    this.session = s;
    this.sessionCreatedAt = Date.now();

    // Optional: log keys once to help mapping later
    // this.log.debug(`EduPage userhome keys: ${Object.keys(s.data || {}).join(', ')}`);

    return this.session;
  }

  _looksLikeAuthProblem(err) {
    const msg = String(err?.message || err || '');
    // Heuristics for "need re-login"
    return (
      msg.includes('responseStart not found') ||
      msg.includes('gpid/gsh missing') ||
      msg.includes('302') ||
      msg.toLowerCase().includes('login') ||
      msg.toLowerCase().includes('unauthorized') ||
      msg.toLowerCase().includes('forbidden')
    );
  }

  async edupageLogin(baseUrl, username, password) {
    const subdomain = this._getSubdomainFromBaseUrl(baseUrl);

    // 1) GET MainLogin (csrftoken)
    const loginPageUrl = `https://${subdomain}.edupage.org/login/?cmd=MainLogin`;
    const r1 = await this.http.get(loginPageUrl);
    const html1 = r1.data;

    const csrfToken = this._extractBetween(html1, '"csrftoken":"', '"');
    if (!csrfToken) throw new Error('EduPage login: csrftoken not found');

    // 2) POST edubarLogin.php
    const loginPostUrl = `https://${subdomain}.edupage.org/login/edubarLogin.php`;
    const r2 = await this.http.post(loginPostUrl, null, {
      params: { csrfauth: csrfToken, username, password },
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });

    const finalUrl = (r2?.request?.res?.responseUrl) || '';
    if (finalUrl.includes('cap=1') || finalUrl.includes('lerr=')) {
      throw new Error('EduPage login blocked (captcha / rate-limit)');
    }
    if (finalUrl.includes('bad=1')) {
      throw new Error('EduPage login failed (bad credentials)');
    }

    const html2 = r2.data;

    // 3) Parse userhome(JSON) + gsec hash
    const userhomeRaw = this._extractBetween(html2, 'userhome(', ');');
    if (!userhomeRaw) throw new Error('EduPage login: userhome(JSON) not found');

    let data;
    try {
      const cleaned = String(userhomeRaw).replace(/\t|\n|\r/g, '');
      data = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`EduPage login: failed to parse userhome JSON: ${e?.message || e}`);
    }

    const gsecHash = this._extractBetween(html2, 'ASC.gsechash="', '"');
    if (!gsecHash) throw new Error('EduPage login: ASC.gsechash not found');

    const userId = data?.userid;
    if (!userId) throw new Error('EduPage login: userid missing in userhome JSON');

    return { subdomain, data, gsecHash, userId };
  }

  async edupageGetMyDayPlan(baseUrl, session, dateISO) {
    const { subdomain, userId } = session;

    // 1) GET dashboard/eb.php?mode=ttday -> extract gpid + gsh (robust)
    const csrfUrl = `https://${subdomain}.edupage.org/dashboard/eb.php?mode=ttday`;
    const r1 = await this.http.get(csrfUrl);
    const html = r1.data;

    const { gpid, gsh } = this._extractGpidAndGsh(html);
    if (!gpid || !gsh) throw new Error('EduPage timetable: gpid/gsh missing');

    const nextGpid = Number(gpid) + 1;

    // 2) POST /gcall action=loadData ...
    const form = new URLSearchParams({
      gpid: String(nextGpid),
      gsh: String(gsh),
      action: 'loadData',
      user: String(userId),
      changes: '{}',
      date: dateISO,
      dateto: dateISO,
      _LJSL: '4096',
    });

    const r2 = await this.http.post(`https://${subdomain}.edupage.org/gcall`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const txt = r2.data;

    const responseStart = `${userId}",`;
    const idxS = txt.indexOf(responseStart);
    if (idxS === -1) throw new Error('EduPage timetable: responseStart not found');
    const after = txt.slice(idxS + responseStart.length);
    const idxE = after.lastIndexOf(',[');
    if (idxE === -1) throw new Error('EduPage timetable: responseEnd not found');

    const jsonStr = after.slice(0, idxE);
    let payload;
    try {
      payload = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`EduPage timetable: JSON parse failed: ${e?.message || e}`);
    }

    const plan = payload?.dates?.[dateISO]?.plan;
    return plan || [];
  }

  _parsePlanToLessons(plan) {
    const lessons = [];

    for (const entry of plan) {
      const header = entry?.header;
      if (header && (!entry.header || entry?.header?.[0]?.cmd === 'addlesson_t')) continue;

      const start = (entry?.starttime || '').replace('24:00', '23:59');
      const end = (entry?.endtime || '').replace('24:00', '23:59');

      const isCanceled = !!entry?.removed || entry?.type === 'absent' || entry?.type === '';
      const isEvent = entry?.type === 'event' || entry?.type === 'out' || !!entry?.main;

      lessons.push({
        start,
        end,
        subjectId: entry?.subjectid ?? null,
        teacherIds: entry?.teacherids ?? [],
        roomIds: entry?.classroomids ?? [],
        groups: (entry?.groupnames ?? []).filter(g => g),
        canceled: isCanceled,
        event: isEvent,
        raw: entry,
      });
    }

    lessons.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    return lessons;
  }

  async syncOnce(baseUrl) {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      let session = await this.ensureSession(baseUrl);

      const todayISO = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowISO = tomorrow.toISOString().slice(0, 10);

      let planToday, planTomorrow;

      try {
        [planToday, planTomorrow] = await Promise.all([
          this.edupageGetMyDayPlan(baseUrl, session, todayISO),
          this.edupageGetMyDayPlan(baseUrl, session, tomorrowISO),
        ]);
      } catch (e) {
        if (this._looksLikeAuthProblem(e)) {
          this.log.info('EduPage session seems invalid, re-login once...');
          this.session = null;
          this.sessionCreatedAt = 0;
          session = await this.ensureSession(baseUrl);

          [planToday, planTomorrow] = await Promise.all([
            this.edupageGetMyDayPlan(baseUrl, session, todayISO),
            this.edupageGetMyDayPlan(baseUrl, session, tomorrowISO),
          ]);
        } else {
          throw e;
        }
      }

      const lessonsToday = this._parsePlanToLessons(planToday);
      const lessonsTomorrow = this._parsePlanToLessons(planTomorrow);

      const mapToAdapterLesson = (l) => ({
        start: l.start || '',
        end: l.end || '',
        subject: l.subjectId != null ? `#${l.subjectId}` : '',
        teacher: (l.teacherIds || []).map(x => `#${x}`).join(', '),
        room: (l.roomIds || []).map(x => `#${x}`).join(', '),
        changed: false,
        canceled: !!l.canceled,
        changeText: l.canceled ? 'canceled' : (l.event ? 'event' : ''),
      });

      const model = {
        today: { date: todayISO, lessons: lessonsToday.map(mapToAdapterLesson).slice(0, this.maxLessons) },
        tomorrow: { date: tomorrowISO, lessons: lessonsTomorrow.map(mapToAdapterLesson).slice(0, this.maxLessons) },
        next: null
      };

      const nowHHMM = new Date().toTimeString().slice(0, 5);
      const nextToday = model.today.lessons.find(x => x.start && x.start > nowHHMM && !x.canceled);
      if (nextToday) {
        model.next = { when: 'today', ...nextToday };
      } else {
        const nextTom = model.tomorrow.lessons.find(x => x.start && !x.canceled);
        if (nextTom) model.next = { when: 'tomorrow', ...nextTom };
      }

      const hash = crypto.createHash('sha1').update(JSON.stringify(model)).digest('hex');
      const prevHash = (await this.getStateAsync('meta.lastHash'))?.val || '';
      await this.setStateAsync('meta.lastHash', hash, true);
      await this.setStateAsync('meta.changedSinceLastSync', hash !== prevHash, true);

      await this.writeModel(model);

      await this.setStateAsync('meta.lastSync', Date.now(), true);
      await this.setStateAsync('info.connection', true, true);
    } catch (e) {
      const msg = e?.message || String(e);
      await this.setStateAsync('meta.lastError', msg, true);
      await this.setStateAsync('info.connection', false, true);
      this.log.warn(`syncOnce failed: ${msg}`);
    }
  }

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);

    await this.writeLessons('today', model.today.lessons || []);
    await this.writeLessons('tomorrow', model.tomorrow.lessons || []);

    const n = model.next || {};
    await this.setStateAsync('next.when', n.when || '', true);
    await this.setStateAsync('next.subject', n.subject || '', true);
    await this.setStateAsync('next.room', n.room || '', true);
    await this.setStateAsync('next.teacher', n.teacher || '', true);
    await this.setStateAsync('next.start', n.start || '', true);
    await this.setStateAsync('next.end', n.end || '', true);
    await this.setStateAsync('next.changed', !!n.changed, true);
    await this.setStateAsync('next.canceled', !!n.canceled, true);
    await this.setStateAsync('next.changeText', n.changeText || '', true);
  }

  async writeLessons(dayKey, lessons) {
    for (let i = 0; i < this.maxLessons; i++) {
      const base = `${dayKey}.lessons.${i}`;
      const l = lessons[i] || null;

      await this.setStateAsync(`${base}.exists`, !!l, true);
      await this.setStateAsync(`${base}.start`, l?.start || '', true);
      await this.setStateAsync(`${base}.end`, l?.end || '', true);
      await this.setStateAsync(`${base}.subject`, l?.subject || '', true);
      await this.setStateAsync(`${base}.room`, l?.room || '', true);
      await this.setStateAsync(`${base}.teacher`, l?.teacher || '', true);
      await this.setStateAsync(`${base}.changed`, !!l?.changed, true);
      await this.setStateAsync(`${base}.canceled`, !!l?.canceled, true);
      await this.setStateAsync(`${base}.changeText`, l?.changeText || '', true);
    }
  }

'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const crypto = require('crypto');

class Edupage extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'edupage' });
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.jar = new CookieJar();
    this.http = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': 'ioBroker.edupage/0.0.1',
        'Accept': 'application/json, text/plain, */*'
      }
    }));

    this.timer = null;
    this.maxLessons = 12;
    // Session caching
    this.session = null;
    this.sessionCreatedAt = 0;
    this.sessionMaxAgeMs = 6 * 60 * 60 * 1000; // 6h
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
    if (!this.config.username || !this.config.password) return this.log.error('Please set username/password');

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    await this.ensureStates();

    await this.syncOnce(baseUrl).catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce(baseUrl).catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastHash', 'string', 'Hash of last model'],
      ['meta.changedSinceLastSync', 'boolean', 'Changed since last sync'],
      ['meta.lastError', 'string', 'Last error message'],
      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],
      ['next.when', 'string', 'today|tomorrow'],
      ['next.subject', 'string', 'Next subject'],
      ['next.room', 'string', 'Next room'],
      ['next.teacher', 'string', 'Next teacher'],
      ['next.start', 'string', 'Next start'],
      ['next.end', 'string', 'Next end'],
      ['next.changed', 'boolean', 'Next changed'],
      ['next.canceled', 'boolean', 'Next canceled'],
      ['next.changeText', 'string', 'Next change text']
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {}
      });
    }

    for (const day of ['today', 'tomorrow']) {
      for (let i = 0; i < this.maxLessons; i++) {
        await this.ensureLessonStates(`${day}.lessons.${i}`);
      }
    }
  }

  async ensureLessonStates(base) {
    const defs = [
      ['exists', 'boolean', 'Lesson exists'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text']
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {}
      });
    }
  }

  _getSubdomainFromBaseUrl(baseUrl) {
    const u = new URL(baseUrl);
    const host = u.hostname;
    return host.split('.')[0];
  }

  _extractBetween(haystack, start, end) {
    const s = haystack.indexOf(start);
    if (s === -1) return null;
    const rest = haystack.slice(s + start.length);
    const e = rest.indexOf(end);
    if (e === -1) return null;
    return rest.slice(0, e);
  }

  // ✅ Robust helper: first regex match
  _extractFirstMatch(text, regex, group = 1) {
    const m = String(text || '').match(regex);
    return m ? m[group] : null;
  }

  // ✅ Robust helper: find gpid + gsh in ttday page
  _extractGpidAndGsh(html) {
    const gpid =
      this._extractFirstMatch(html, /[?&]gpid=(\d+)/) ||
      this._extractFirstMatch(html, /\bgpid\s*=\s*(\d+)/) ||
      this._extractFirstMatch(html, /"gpid"\s*:\s*(\d+)/);

    const gsh =
      this._extractFirstMatch(html, /[?&]gsh=([^"&]+)/) ||
      this._extractFirstMatch(html, /\bgsh\s*=\s*"([^"]+)"/) ||
      this._extractFirstMatch(html, /"gsh"\s*:\s*"([^"]+)"/);

    return { gpid, gsh };
  }

  _isSessionValid() {
    if (!this.session) return false;
    if (!this.sessionCreatedAt) return false;
    const age = Date.now() - this.sessionCreatedAt;
    return age < this.sessionMaxAgeMs;
  }

  _resetSession() {
    this.session = null;
    this.sessionCreatedAt = 0;
    this.jar = new CookieJar();
    this.http = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      timeout: 20000,
      headers: {
        'User-Agent': 'ioBroker.edupage/0.0.1',
        'Accept': 'application/json, text/plain, */*'
      }
    }));
  }

  async ensureSession(baseUrl) {
    // Already valid? Use it.
    if (this._isSessionValid()) return this.session;

    // Recreate jar+client to avoid stale/bad cookies
    this._resetSession();

    // Login once
    const s = await this.edupageLogin(baseUrl, this.config.username, this.config.password);
    this.session = s;
    this.sessionCreatedAt = Date.now();

    // Optional: log keys once to help mapping later
    // this.log.debug(`EduPage userhome keys: ${Object.keys(s.data || {}).join(', ')}`);

    return this.session;
  }

  _looksLikeAuthProblem(err) {
    const msg = String(err?.message || err || '');
    // Heuristics for "need re-login"
    return (
      msg.includes('responseStart not found') ||
      msg.includes('gpid/gsh missing') ||
      msg.includes('302') ||
      msg.toLowerCase().includes('login') ||
      msg.toLowerCase().includes('unauthorized') ||
      msg.toLowerCase().includes('forbidden')
    );
  }

  async edupageLogin(baseUrl, username, password) {
    const subdomain = this._getSubdomainFromBaseUrl(baseUrl);

    // 1) GET MainLogin (csrftoken)
    const loginPageUrl = `https://${subdomain}.edupage.org/login/?cmd=MainLogin`;
    const r1 = await this.http.get(loginPageUrl);
    const html1 = r1.data;

    const csrfToken = this._extractBetween(html1, '"csrftoken":"', '"');
    if (!csrfToken) throw new Error('EduPage login: csrftoken not found');

    // 2) POST edubarLogin.php
    const loginPostUrl = `https://${subdomain}.edupage.org/login/edubarLogin.php`;
    const r2 = await this.http.post(loginPostUrl, null, {
      params: { csrfauth: csrfToken, username, password },
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });

    const finalUrl = (r2?.request?.res?.responseUrl) || '';
    if (finalUrl.includes('cap=1') || finalUrl.includes('lerr=')) {
      throw new Error('EduPage login blocked (captcha / rate-limit)');
    }
    if (finalUrl.includes('bad=1')) {
      throw new Error('EduPage login failed (bad credentials)');
    }

    const html2 = r2.data;

    // 3) Parse userhome(JSON) + gsec hash
    const userhomeRaw = this._extractBetween(html2, 'userhome(', ');');
    if (!userhomeRaw) throw new Error('EduPage login: userhome(JSON) not found');

    let data;
    try {
      const cleaned = String(userhomeRaw).replace(/\t|\n|\r/g, '');
      data = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`EduPage login: failed to parse userhome JSON: ${e?.message || e}`);
    }

    const gsecHash = this._extractBetween(html2, 'ASC.gsechash="', '"');
    if (!gsecHash) throw new Error('EduPage login: ASC.gsechash not found');

    const userId = data?.userid;
    if (!userId) throw new Error('EduPage login: userid missing in userhome JSON');

    return { subdomain, data, gsecHash, userId };
  }

  async edupageGetMyDayPlan(baseUrl, session, dateISO) {
    const { subdomain, userId } = session;

    // 1) GET dashboard/eb.php?mode=ttday -> extract gpid + gsh (robust)
    const csrfUrl = `https://${subdomain}.edupage.org/dashboard/eb.php?mode=ttday`;
    const r1 = await this.http.get(csrfUrl);
    const html = r1.data;

    const { gpid, gsh } = this._extractGpidAndGsh(html);
    if (!gpid || !gsh) throw new Error('EduPage timetable: gpid/gsh missing');

    const nextGpid = Number(gpid) + 1;

    // 2) POST /gcall action=loadData ...
    const form = new URLSearchParams({
      gpid: String(nextGpid),
      gsh: String(gsh),
      action: 'loadData',
      user: String(userId),
      changes: '{}',
      date: dateISO,
      dateto: dateISO,
      _LJSL: '4096',
    });

    const r2 = await this.http.post(`https://${subdomain}.edupage.org/gcall`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const txt = r2.data;

    const responseStart = `${userId}",`;
    const idxS = txt.indexOf(responseStart);
    if (idxS === -1) throw new Error('EduPage timetable: responseStart not found');
    const after = txt.slice(idxS + responseStart.length);
    const idxE = after.lastIndexOf(',[');
    if (idxE === -1) throw new Error('EduPage timetable: responseEnd not found');

    const jsonStr = after.slice(0, idxE);
    let payload;
    try {
      payload = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`EduPage timetable: JSON parse failed: ${e?.message || e}`);
    }

    const plan = payload?.dates?.[dateISO]?.plan;
    return plan || [];
  }

  _parsePlanToLessons(plan) {
    const lessons = [];

    for (const entry of plan) {
      const header = entry?.header;
      if (header && (!entry.header || entry?.header?.[0]?.cmd === 'addlesson_t')) continue;

      const start = (entry?.starttime || '').replace('24:00', '23:59');
      const end = (entry?.endtime || '').replace('24:00', '23:59');

      const isCanceled = !!entry?.removed || entry?.type === 'absent' || entry?.type === '';
      const isEvent = entry?.type === 'event' || entry?.type === 'out' || !!entry?.main;

      lessons.push({
        start,
        end,
        subjectId: entry?.subjectid ?? null,
        teacherIds: entry?.teacherids ?? [],
        roomIds: entry?.classroomids ?? [],
        groups: (entry?.groupnames ?? []).filter(g => g),
        canceled: isCanceled,
        event: isEvent,
        raw: entry,
      });
    }

    lessons.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    return lessons;
  }

  async syncOnce(baseUrl) {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      let session = await this.ensureSession(baseUrl);

      const todayISO = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowISO = tomorrow.toISOString().slice(0, 10);

  let planToday, planTomorrow;

  try {
    [planToday, planTomorrow] = await Promise.all([
      this.edupageGetMyDayPlan(baseUrl, session, todayISO),
      this.edupageGetMyDayPlan(baseUrl, session, tomorrowISO),
    ]);
  } catch (e) {
    // If session expired / cookies invalid -> re-login once
    if (this._looksLikeAuthProblem(e)) {
      this.log.info('EduPage session seems invalid, re-login once...');
      this.session = null;
      this.sessionCreatedAt = 0;
      session = await this.ensureSession(baseUrl);

      [planToday, planTomorrow] = await Promise.all([
        this.edupageGetMyDayPlan(baseUrl, session, todayISO),
        this.edupageGetMyDayPlan(baseUrl, session, tomorrowISO),
      ]);
    } else {
      throw e;
    }
  }

      const lessonsToday = this._parsePlanToLessons(planToday);
      const lessonsTomorrow = this._parsePlanToLessons(planTomorrow);

      const mapToAdapterLesson = (l) => ({
        start: l.start || '',
        end: l.end || '',
        subject: l.subjectId != null ? `#${l.subjectId}` : '',
        teacher: (l.teacherIds || []).map(x => `#${x}`).join(', '),
        room: (l.roomIds || []).map(x => `#${x}`).join(', '),
        changed: false,
        canceled: !!l.canceled,
        changeText: l.canceled ? 'canceled' : (l.event ? 'event' : ''),
      });

      const model = {
        today: { date: todayISO, lessons: lessonsToday.map(mapToAdapterLesson).slice(0, this.maxLessons) },
        tomorrow: { date: tomorrowISO, lessons: lessonsTomorrow.map(mapToAdapterLesson).slice(0, this.maxLessons) },
        next: null
      };

      const nowHHMM = new Date().toTimeString().slice(0, 5);
      const nextToday = model.today.lessons.find(x => x.start && x.start > nowHHMM && !x.canceled);
      if (nextToday) {
        model.next = { when: 'today', ...nextToday };
      } else {
        const nextTom = model.tomorrow.lessons.find(x => x.start && !x.canceled);
        if (nextTom) model.next = { when: 'tomorrow', ...nextTom };
      }

      const hash = crypto.createHash('sha1').update(JSON.stringify(model)).digest('hex');
      const prevHash = (await this.getStateAsync('meta.lastHash'))?.val || '';
      await this.setStateAsync('meta.lastHash', hash, true);
      await this.setStateAsync('meta.changedSinceLastSync', hash !== prevHash, true);

      await this.writeModel(model);

      await this.setStateAsync('meta.lastSync', Date.now(), true);
      await this.setStateAsync('info.connection', true, true);
    } catch (e) {
      const msg = e?.message || String(e);
      await this.setStateAsync('meta.lastError', msg, true);
      await this.setStateAsync('info.connection', false, true);
      this.log.warn(`syncOnce failed: ${msg}`);
    }
  }

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);

    await this.writeLessons('today', model.today.lessons || []);
    await this.writeLessons('tomorrow', model.tomorrow.lessons || []);

    const n = model.next || {};
    await this.setStateAsync('next.when', n.when || '', true);
    await this.setStateAsync('next.subject', n.subject || '', true);
    await this.setStateAsync('next.room', n.room || '', true);
    await this.setStateAsync('next.teacher', n.teacher || '', true);
    await this.setStateAsync('next.start', n.start || '', true);
    await this.setStateAsync('next.end', n.end || '', true);
    await this.setStateAsync('next.changed', !!n.changed, true);
    await this.setStateAsync('next.canceled', !!n.canceled, true);
    await this.setStateAsync('next.changeText', n.changeText || '', true);
  }

  async writeLessons(dayKey, lessons) {
    for (let i = 0; i < this.maxLessons; i++) {
      const base = `${dayKey}.lessons.${i}`;
      const l = lessons[i] || null;

      await this.setStateAsync(`${base}.exists`, !!l, true);
      await this.setStateAsync(`${base}.start`, l?.start || '', true);
      await this.setStateAsync(`${base}.end`, l?.end || '', true);
      await this.setStateAsync(`${base}.subject`, l?.subject || '', true);
      await this.setStateAsync(`${base}.room`, l?.room || '', true);
      await this.setStateAsync(`${base}.teacher`, l?.teacher || '', true);
      await this.setStateAsync(`${base}.changed`, !!l?.changed, true);
      await this.setStateAsync(`${base}.canceled`, !!l?.canceled, true);
      await this.setStateAsync(`${base}.changeText`, l?.changeText || '', true);
    }
  }

  onUnload(callback) {
    try {
      if (this.timer) clearInterval(this.timer);
    } finally {
      this.session = null;
      this.sessionCreatedAt = 0;
      callback();
    }
  }


if (require.main !== module) {
  module.exports = (options) => new Edupage(options);
} else {
  new Edupage();
}


if (require.main !== module) {
  module.exports = (options) => new Edupage(options);
} else {
  new Edupage();
}
