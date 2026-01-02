'use strict';

const utils = require('@iobroker/adapter-core');
const { EdupageHttp } = require('./lib/edupageHttp');
const { EdupageClient } = require('./lib/edupageClient');

class Edupage extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'edupage' });

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));

    this.timer = null;
    this.maxLessons = 12;

    this.captchaBackoffUntil = 0;
    this.stopOnCaptcha = true; // requested
  }

  async onReady() {
    this.setState('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      // do not show private school name in example
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    const weekView = !!this.config.enableWeek;

    await this.ensureStates();

    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    await this.syncOnce({ schoolSubdomain, weekView }).catch(e =>
      this.log.warn(`Initial sync failed: ${e?.message || e}`)
    );

    this.timer = setInterval(() => {
      this.syncOnce({ schoolSubdomain, weekView }).catch(e =>
        this.log.warn(`Sync failed: ${e?.message || e}`)
      );
    }, intervalMin * 60 * 1000);
  }

  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.captchaRequired', 'boolean', 'Captcha required by EduPage'],
      ['meta.captchaUrl', 'string', 'Captcha URL (open in browser)'],
      ['meta.captchaUntil', 'number', 'Backoff until timestamp (ms)'],

      ['today.date', 'string', 'Today date'],
      ['tomorrow.date', 'string', 'Tomorrow date'],

      ['week.dateFrom', 'string', 'Week range start (YYYY-MM-DD)'],
      ['week.dateTo', 'string', 'Week range end (YYYY-MM-DD)'],

      ['today.ferien', 'string', 'Holiday/event text if present (today)'],
      ['tomorrow.ferien', 'string', 'Holiday/event text if present (tomorrow)'],

      ['next.when', 'string', 'today|tomorrow|week'],
      ['next.subject', 'string', 'Next subject'],
      ['next.room', 'string', 'Next room'],
      ['next.teacher', 'string', 'Next teacher'],
      ['next.start', 'string', 'Next start'],
      ['next.end', 'string', 'Next end'],
      ['next.changed', 'boolean', 'Next changed'],
      ['next.canceled', 'boolean', 'Next canceled'],
      ['next.changeText', 'string', 'Next change text'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
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
      ['date', 'string', 'YYYY-MM-DD'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text'],
      ['type', 'string', 'lesson|event'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  async syncOnce({ schoolSubdomain, weekView }) {
    if (this.captchaBackoffUntil && Date.now() < this.captchaBackoffUntil) {
      const mins = Math.ceil((this.captchaBackoffUntil - Date.now()) / 60000);
      this.log.warn(`[Backoff] Captcha required by EduPage. Next try in ~${mins} min.`);
      return;
    }

    try {
      await this.setStateAsync('meta.lastError', '', true);
      await this.setStateAsync('meta.captchaRequired', false, true);
      await this.setStateAsync('meta.captchaUrl', '', true);

      const studentId = (this.config.studentId ?? '').toString().trim();
      const gshCfg = (this.config.gsh ?? '').toString().trim();

      // 0) getData
      const md = await this.eduClient.getLoginData().catch(() => null);

      // Option A: gu IMMER verfügbar machen (fallback)
      const guPath = (md?.gu && String(md.gu)) ? String(md.gu) : this.eduClient.getTimetableRefererPath();

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: schoolSubdomain,
      });
      if (!tokRes?.token) throw new Error(tokRes?.err?.error_text || 'No token');

      // 2) login
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: schoolSubdomain,
        ctxt: '',
        tu: md?.tu ?? null,
        gu: guPath,          // <-- IMPORTANT
        au: md?.au ?? null,
      });

      const errText = loginRes?.err?.error_text || '';
      const needCaptcha = /verdächtige|zusätzlich überprüfen|Text aus dem Bild|captcha/i.test(errText);

      if (needCaptcha || loginRes?.needCaptcha === '1' || loginRes?.captchaSrc) {
        const captchaUrl = this.makeAbsoluteUrl(loginRes?.captchaSrc || '');
        await this.handleCaptcha(captchaUrl || null);
        return;
      }

      if (loginRes?.status !== 'OK') {
        throw new Error(loginRes?.err?.error_text || 'Login failed');
      }

      // 3) warmup timetable (sets context; also helps _gsh extraction)
      await this.eduClient.warmUpTimetable({ guPath });

      // 4) dates
      const model = this.emptyModel();
      let dateFrom = model.today.date;
      let dateTo = model.tomorrow.date;

      if (weekView) {
        const d = new Date();
        const day = (d.getDay() + 6) % 7; // Mon=0
        const monday = new Date(d);
        monday.setDate(d.getDate() - day);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        dateFrom = monday.toISOString().slice(0, 10);
        dateTo = sunday.toISOString().slice(0, 10);

        await this.setStateAsync('week.dateFrom', dateFrom, true);
        await this.setStateAsync('week.dateTo', dateTo, true);
      }

      // 5) studentId required
      if (!studentId) {
        this.log.warn('No studentId set yet. Please add it in adapter settings (example: 1234).');
        this.setState('info.connection', true, true);
        await this.setStateAsync('meta.lastSync', Date.now(), true);
        return;
      }

      // 6) _gsh: config or auto
      let gsh = gshCfg;
      if (!gsh) {
        gsh = await this.eduClient.getGsh({ guPath });
      }

      // 7) timetable call (with proper Referer/Origin)
      const yyyy = new Date().getFullYear();
      const args = [
        null,
        {
          year: yyyy,
          datefrom: dateFrom,
          dateto: dateTo,
          table: 'students',
          id: String(studentId),
          showColors: true,
          showIgroupsInClasses: false,
          showOrig: true,
          log_module: 'CurrentTTView',
        },
      ];

      const ttRes = await this.eduClient.currentttGetData({ args, gsh, guPath });

      const parsed = this.parseCurrentTt(ttRes);
      await this.writeModel(parsed);

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);
    } catch (e) {
      const msg = String(e?.message || e);
      await this.setStateAsync('meta.lastError', msg, true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  makeAbsoluteUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.eduHttp?.baseUrl || '').replace(/\/+$/, '');
    return base + (path.startsWith('/') ? path : `/${path}`);
  }

  async handleCaptcha(captchaUrl) {
    await this.setStateAsync('meta.captchaRequired', true, true);
    await this.setStateAsync('meta.captchaUrl', captchaUrl || '', true);

    this.captchaBackoffUntil = Date.now() + 60 * 60 * 1000;
    await this.setStateAsync('meta.captchaUntil', this.captchaBackoffUntil, true);

    if (captchaUrl) {
      this.log.error(
        `Captcha nötig / verdächtige Aktivität erkannt. Öffne diese URL im Browser, gib das Passwort erneut ein und tippe den Text aus dem Bild ein: ${captchaUrl}`
      );
    } else {
      this.log.error('Captcha nötig / verdächtige Aktivität erkannt. Bitte im Browser bei EduPage erneut anmelden und Captcha lösen.');
    }

    if (this.stopOnCaptcha) {
      this.log.warn('Stopping adapter due to captcha requirement (manual restart after captcha solved).');
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.terminate?.('Captcha required by EduPage').catch(() => {});
    }
  }

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [], ferien: '' },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [], ferien: '' },
      next: null,
    };
  }

  parseCurrentTt(ttRes) {
    const model = this.emptyModel();
    const r = ttRes?.r || ttRes?.data?.r || ttRes || {};
    const items = r?.ttitems || [];

    const byDateEvent = new Map();
    for (const it of items) {
      if (it?.type === 'event' && it?.date && it?.name) {
        if (!byDateEvent.has(it.date)) byDateEvent.set(it.date, it.name);
      }
    }
    model.today.ferien = byDateEvent.get(model.today.date) || '';
    model.tomorrow.ferien = byDateEvent.get(model.tomorrow.date) || '';

    return model;
  }

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);
    await this.setStateAsync('today.ferien', model.today.ferien || '', true);
    await this.setStateAsync('tomorrow.ferien', model.tomorrow.ferien || '', true);

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
  module.exports = options => new Edupage(options);
} else {
  new Edupage();
}
