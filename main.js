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
    // Make sure we always see something on startup
    this.log.info('Edupage adapter starting onReady()');

    await this.setStateAsync('info.connection', false, true);

    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // do not log real school name, only if it matches *.edupage.org
    const m = baseUrl.match(/^https?:\/\/([^./]+)\.edupage\.org/i);
    const schoolSubdomain = m?.[1] || '';

    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    const weekView = !!this.config.enableWeek;

    this.log.info(
      `Config: baseUrl=${m ? 'https://myschool.edupage.org' : '[custom]'} intervalMin=${intervalMin} maxLessons=${this.maxLessons} weekView=${weekView}`
    );

    await this.ensureStates();

    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    await this.syncOnce({ schoolSubdomain, weekView }).catch(e => {
      this.log.warn(`Initial sync failed: ${e?.message || e}`);
    });

    this.timer = setInterval(() => {
      this.syncOnce({ schoolSubdomain, weekView }).catch(e => {
        this.log.warn(`Sync failed: ${e?.message || e}`);
      });
    }, intervalMin * 60 * 1000);

    this.log.info(`Scheduler active: every ${intervalMin} minutes`);
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
      ['today.holiday', 'boolean', 'Holiday active today'],
      ['today.holidayName', 'string', 'Holiday name/event text today'],
      ['tomorrow.holiday', 'boolean', 'Holiday active tomorrow'],
      ['tomorrow.holidayName', 'string', 'Holiday name/event text tomorrow'],

      ['next.when', 'string', 'today|tomorrow|week'],
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
      ['date', 'string', 'YYYY-MM-DD'],
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text'],
      ['type', 'string', 'lesson|event']
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {}
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

      this.log.info(`Sync start (weekView=${weekView}). studentId set: ${studentId ? 'yes' : 'no'}`);

      // 0) getData
      const md = await this.eduClient.getLoginData().catch(() => null);
      const guPath = this.eduClient.getDashboardTimetableRefererPath();

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: schoolSubdomain
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
        gu: guPath,
        au: md?.au ?? null
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

      // 2.5) post-login warmup to obtain full session cookies (e.g. edusrs)
      await this.eduHttp.get('/login/').catch(() => {});
      await this.eduHttp.get('/').catch(() => {});
      await this.eduHttp.get('/dashboard/').catch(() => {});
      await this.eduHttp.get('/dashboard/eb.php?mode=timetable').catch(() => {});


      // 3) warmup timetable
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
        await this.setStateAsync('meta.lastSync', Date.now(), true);
        await this.setStateAsync('info.connection', true, true);
        return;
      }

      // 6) _gsh must be provided from DevTools (auto-detect is unreliable)
      if (!gshCfg) {
        throw new Error(
          'Missing _gsh in adapter config. Please copy it from DevTools (8 hex) and paste into settings.'
        );
      }

      // 6) _gsh must be provided from DevTools (auto-detect is unreliable)
      if (!gshCfg) {
        throw new Error(
          'Missing _gsh in adapter config. Please copy it from DevTools (8 hex) and paste into settings.'
        );
      }

      let gsh = gshCfg;

      // 7) timetable call (with proper Referer/Origin)

      // IMPORTANT: EduPage expects negative student id for table="students"
      const sid = Number(studentId);
      const eduId = sid > 0 ? String(-sid) : String(sid);

      // IMPORTANT: EduPage expects "year" from dateFrom (week crossing year boundary)
      const yyyy = Number(String(dateFrom).slice(0, 4)) || new Date().getFullYear();

      // DEBUG: make sure payload matches browser request
      this.log.warn(`TT payload check: year=${yyyy} datefrom=${dateFrom} dateto=${dateTo} id=${eduId}`);

      const args = [
        null,
        {
          year: yyyy,
          datefrom: dateFrom,
          dateto: dateTo,
          table: 'students',
          id: eduId,
          showColors: true,
          showIgroupsInClasses: false,
          showOrig: true,
          log_module: 'CurrentTTView',
        },
      ];

      // First call
      let ttRes = await this.eduClient.currentttGetData({ args, gsh, guPath });

      // One retry if EduPage asks for reload
      if (ttRes && typeof ttRes === 'object' && ttRes.reload === true) {
        this.log.warn(`TT returned reload. Retrying once... (ttRes=${JSON.stringify(ttRes)})`);
        ttRes = await this.eduClient.currentttGetData({ args, gsh, guPath });
        this.log.warn(`TT raw after retry: ${JSON.stringify(ttRes)}`);
      }

      // Parse + write exactly once
      const parsed = this.parseCurrentTt(ttRes);
      await this.writeModel(parsed);

      await this.setStateAsync('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

      this.log.info(
        `Sync done. today.ferien="${parsed.today.ferien || ''}" today.holiday=${parsed.today.holiday} tomorrow.ferien="${parsed.tomorrow.ferien || ''}" tomorrow.holiday=${parsed.tomorrow.holiday}`
      );

    } catch (e) {
      const msg = String(e?.message || e);
      await this.setStateAsync('meta.lastError', msg, true);
      await this.setStateAsync('info.connection', false, true);
      this.log.error(`Sync error: ${msg}`);
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
      this.log.error(
        'Captcha nötig / verdächtige Aktivität erkannt. Bitte im Browser bei EduPage erneut anmelden und Captcha lösen.'
      );
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
      today: {
        date: today.toISOString().slice(0, 10),
        lessons: [],
        ferien: '',
        holiday: false,
        holidayName: ''
      },
      tomorrow: {
        date: tomorrow.toISOString().slice(0, 10),
        lessons: [],
        ferien: '',
        holiday: false,
        holidayName: ''
      },
      next: null
    };
  }

  normalizeDate(d) {
    if (!d) return '';
    const s = String(d).trim();

    // ISO already
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // "YYYY-MM-DDTHH:MM:SS..." -> slice
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);

    // "DD.MM.YYYY" -> ISO
    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      return `${yyyy}-${mm}-${dd}`;
    }

    return s;
  }

  parseCurrentTt(ttRes) {
    const model = this.emptyModel();
    const r = ttRes?.r || ttRes?.data?.r || ttRes || {};

    const items = r?.ttitems || r?.eventitems || r?.events || r?.items || [];

    const getText = it => it?.name || it?.title || it?.caption || it?.text || '';
    const getType = it => String(it?.type || '').toLowerCase();

    const isHolidayText = txt => {
      const t = String(txt || '').toLowerCase();
      return (
        t.includes('ferien') ||
        t.includes('holiday') ||
        t.includes('vacation') ||
        t.includes('break') ||
        t.includes('school closed') ||
        t.includes('frei') ||
        t.includes('unterrichtsfrei')
      );
    };

    const byDateEvent = new Map();

    for (const it of items) {
      const type = getType(it);
      const txt = getText(it);
      if (!txt) continue;

      // 1) single date event
      if (it?.date && (type === 'event' || type === 'holiday' || type === 'dayevent')) {
        const d = this.normalizeDate(it.date);
        if (d && !byDateEvent.has(d)) byDateEvent.set(d, txt);
        continue;
      }

      // 2) ranged event (inclusive)
      if (it?.datefrom && it?.dateto && (type === 'event' || type === 'holiday')) {
        const from = this.normalizeDate(it.datefrom);
        const to = this.normalizeDate(it.dateto);

        if (from && to) {
          if (model.today.date >= from && model.today.date <= to) {
            if (!byDateEvent.has(model.today.date)) byDateEvent.set(model.today.date, txt);
          }
          if (model.tomorrow.date >= from && model.tomorrow.date <= to) {
            if (!byDateEvent.has(model.tomorrow.date)) byDateEvent.set(model.tomorrow.date, txt);
          }
        }
      }
    }

    model.today.ferien = byDateEvent.get(model.today.date) || '';
    model.tomorrow.ferien = byDateEvent.get(model.tomorrow.date) || '';

    model.today.holiday = !!model.today.ferien && isHolidayText(model.today.ferien);
    model.today.holidayName = model.today.holiday ? model.today.ferien : '';

    model.tomorrow.holiday = !!model.tomorrow.ferien && isHolidayText(model.tomorrow.ferien);
    model.tomorrow.holidayName = model.tomorrow.holiday ? model.tomorrow.ferien : '';

    return model;
  }

  async writeModel(model) {
    await this.setStateAsync('today.date', model.today.date, true);
    await this.setStateAsync('tomorrow.date', model.tomorrow.date, true);
    await this.setStateAsync('today.ferien', model.today.ferien || '', true);
    await this.setStateAsync('tomorrow.ferien', model.tomorrow.ferien || '', true);

    await this.setStateAsync('today.holiday', !!model.today.holiday, true);
    await this.setStateAsync('today.holidayName', model.today.holidayName || '', true);
    await this.setStateAsync('tomorrow.holiday', !!model.tomorrow.holiday, true);
    await this.setStateAsync('tomorrow.holidayName', model.tomorrow.holidayName || '', true);

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
  // For local dev execution
  new Edupage();
}
