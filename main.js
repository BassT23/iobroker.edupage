'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const crypto = require('crypto');

const { EdupageClient } = require('./lib/edupageClient');

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
        'Accept': 'application/json, text/plain, */*',
      },
    }));

    this.timer = null;
    this.maxLessons = 12;
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
      ['start', 'string', 'Start HH:MM'],
      ['end', 'string', 'End HH:MM'],
      ['subject', 'string', 'Subject'],
      ['room', 'string', 'Room'],
      ['teacher', 'string', 'Teacher'],
      ['changed', 'boolean', 'Changed'],
      ['canceled', 'boolean', 'Canceled'],
      ['changeText', 'string', 'Change text'],
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(`${base}.${id}`, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  getSchoolIdFromBaseUrl(baseUrl) {
    try {
      const u = new URL(baseUrl);
      // rs-kollnau.edupage.org -> rs-kollnau
      return (u.hostname || '').split('.')[0] || '';
    } catch {
      return '';
    }
  }

  async syncOnce(baseUrl) {
    try {
      await this.setStateAsync('meta.lastError', '', true);

      const schoolId = this.getSchoolIdFromBaseUrl(baseUrl);
      if (!schoolId) throw new Error('Cannot derive school id from baseUrl');

      const client = new EdupageClient({
        http: this.http,
        baseUrl,
        log: this.log,
        // optional: you can pass schoolId into client too
      });

      // 1) getToken
      const tokRes = await client.getToken({
        username: this.config.username,
        edupage: schoolId,
      });

      if (!tokRes?.token) {
        throw new Error(tokRes?.err?.error_text || 'No token from getToken');
      }

      // 2) login
      const loginRes = await client.login({
        username: this.config.username,
        password: this.config.password,
        edupage: schoolId,
        userToken: tokRes.token,
        ctxt: '',
        tu: null,
        gu: null,
        au: null,
      });

      if (loginRes?.status !== 'OK') {
        const needCaptcha = loginRes?.needCaptcha === '1';
        const captchaInfo = needCaptcha ? ` (captcha required, open UI and login once)` : '';
        throw new Error((loginRes?.err?.error_text || 'Login failed') + captchaInfo);
      }

      // For now: keep schema alive with an empty model
      const model = this.emptyModel();
      await this.writeModel(model);

      const hash = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
      const prev = (await this.getStateAsync('meta.lastHash'))?.val || '';
      await this.setStateAsync('meta.lastHash', hash, true);
      await this.setStateAsync('meta.changedSinceLastSync', !!prev && prev !== hash, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

      this.setState('info.connection', true, true);
    } catch (e) {
      await this.setStateAsync('meta.lastError', String(e?.message || e), true);
      this.setState('info.connection', false, true);
      throw e;
    }
  }

  emptyModel() {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    return {
      today: { date: today.toISOString().slice(0, 10), lessons: [] },
      tomorrow: { date: tomorrow.toISOString().slice(0, 10), lessons: [] },
      next: null,
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
