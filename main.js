'use strict';

const utils = require('@iobroker/adapter-core');
const { EdupageHttp } = require('./lib/edupageHttp');
const { EdupageClient } = require('./lib/edupageClient');

class Edupage extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'edupage' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.timer = null;
    this.maxLessons = 12;

    // Captcha flow
    this._captchaPending = false;
    this._captchaUrl = '';
    this._lastSyncRunning = false;
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }
    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    // Create states
    await this.ensureStates();

    // Subscribe for captchaText changes
    await this.subscribeStatesAsync('control.captchaText');

    // Init http+client (keep cookies)
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // Initial sync
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    // Only handle captchaText
    if (id === `${this.namespace}.control.captchaText`) {
      const txt = String(state.val || '').trim();
      if (!txt) {
        await this.setStateAsync('control.captchaText', '', true);
        return;
      }

      if (!this._captchaPending) {
        this.log.warn(`captchaText set (${txt}) but no captcha is pending right now. Ignoring.`);
        await this.setStateAsync('control.captchaText', '', true);
        return;
      }

      this.log.warn(`Captcha text received: "${txt}" -> retry login now...`);
      await this.setStateAsync('control.captchaText', '', true);

      // retry sync immediately with captcha text
      await this.syncOnce({ captchaText: txt }).catch(e => this.log.warn(`Captcha retry failed: ${e?.message || e}`));
    }
  }

  // ---------- Core sync ----------
  async syncOnce({ captchaText } = {}) {
    if (this._lastSyncRunning) return; // avoid overlap
    this._lastSyncRunning = true;

    try {
      await this.setStateAsync('meta.lastError', '', true);

      // Optional: read login metadata (tu/gu/au etc)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // Token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school,
      });
      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // Login (ctxt = captchaText if provided)
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: captchaText ? captchaText : '',
        tu: md?.tu ?? null,
        gu: md?.gu ?? null,
        au: md?.au ?? null,
      });

      // Captcha detection
      // (EduPage usually sends needCaptcha=1 + captchaSrc when suspicious)
      if ((loginRes?.needCaptcha == '1' || loginRes?.captchaSrc) && !captchaText) {
        const url = this.makeAbsoluteCaptchaUrl(loginRes.captchaSrc);
        this._captchaPending = true;
        this._captchaUrl = url;

        await this.setStateAsync('control.captchaUrl', url || '', true);

        this.log.warn('EduPage requires captcha for login (suspicious activity).');
        if (url) {
          this.log.warn(`Open captcha URL in browser, read text, then set state: ${this.namespace}.control.captchaText`);
          this.log.warn(`Captcha URL: ${url}`);
        } else {
          this.log.warn('Captcha requested but captchaSrc missing. Please open the EduPage login once and try again.');
        }

        // keep connection false while captcha pending
        this.setState('info.connection', false, true);
        return;
      }

      // If still not OK
      if (loginRes?.status !== 'OK') {
        // if server returned captcha but we tried with text and it still fails -> show captcha again
        const errText = loginRes?.err?.error_text || 'Login failed';
        throw new Error(errText);
      }

      // Login OK -> clear captcha flags
      this._captchaPending = false;
      this._captchaUrl = '';
      await this.setStateAsync('control.captchaUrl', '', true);

      // ---- Fetch timetable (you already found currentttGetData endpoint) ----
      // You can choose args from your DevTools payload. For now we call once with minimal args.
      // Tip: You can store student id/table config later, but this proves endpoint works.
      const args = [null, {
        year: new Date().getFullYear(),
        datefrom: this.toISODate(new Date()),
        dateto: this.toISODate(new Date(Date.now() + 7 * 86400000)),
        table: 'students',
        id: this.config.studentId || '', // optional config, can be empty
        showColors: true,
        showIgroupsInClasses: false,
        showOrig: true,
        log_module: 'CurrentTTView'
      }];

      // _gsh might be required depending on account; your client can try to auto-detect
      let gsh = null;
      try {
        gsh = await this.eduClient.getGsh();
      } catch (e) {
        // not fatal; some installations work without it
      }

      const tt = await this.eduClient.currentttGetData({ args, gsh });

      // For now, just keep connection OK and store meta. (Parsing lessons can come next.)
      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

      // Optional: mark changedSinceLastSync etc later
    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    } finally {
      this._lastSyncRunning = false;
    }
  }

  makeAbsoluteCaptchaUrl(captchaSrc) {
    if (!captchaSrc) return '';
    if (/^https?:\/\//i.test(captchaSrc)) return captchaSrc;

    // captchaSrc is usually something like "/captcha?t=...&m=..."
    const base = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return captchaSrc;
    if (captchaSrc.startsWith('/')) return `${base}${captchaSrc}`;
    return `${base}/${captchaSrc}`;
  }

  toISODate(d) {
    const dd = new Date(d);
    return dd.toISOString().slice(0, 10);
  }

  // ---------- States ----------
  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastHash', 'string', 'Hash of last model'],
      ['meta.changedSinceLastSync', 'boolean', 'Changed since last sync'],
      ['meta.lastError', 'string', 'Last error message'],

      // Captcha control
      ['control.captchaUrl', 'string', 'Captcha image URL (open in browser)'],
      ['control.captchaText', 'string', 'Captcha text you read from image (write here)'],

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
      const isWrite = (id === 'control.captchaText');
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: isWrite },
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

  // (writeModel/writeLessons are still here so your adapter stays complete,
  // even if parsing is added later.)
  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [] },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [] },
      next: null
    };
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
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Edupage(options);
} else {
  new Edupage();
}
