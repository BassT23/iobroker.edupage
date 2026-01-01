'use strict';

/*
  ioBroker.edupage - main.js (with captcha detection + backoff)
  - Example URL in log uses https://myschool.edupage.org
  - Captcha URL is written to log + stored in state meta.captchaSrc
  - Backoff: after suspicious/captcha/login failures, pause retries for a while
*/

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

    // Backoff / throttling
    this.nextAllowedSyncTs = 0;
    this.failCount = 0;
    this.lastFailReason = '';
  }

  async onReady() {
    this.setState('info.connection', false, true);

    // Config
    const baseUrl = (this.config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      this.log.error('Please set baseUrl (e.g. https://myschool.edupage.org)');
      return;
    }
    if (!this.config.username || !this.config.password) {
      this.log.warn('No username/password set yet. Adapter stays idle until configured.');
      return;
    }

    // optional UI setting
    this.maxLessons = Math.max(6, Number(this.config.maxLessons || 12));

    await this.ensureStates();

    // Create http+client once => cookies persist
    this.eduHttp = new EdupageHttp({ baseUrl, log: this.log });
    this.eduClient = new EdupageClient({ http: this.eduHttp, log: this.log });

    // Initial sync
    await this.syncOnce().catch(e => this.log.warn(`Initial sync failed: ${e?.message || e}`));

    // Schedule
    const intervalMin = Math.max(5, Number(this.config.intervalMin || 15));
    this.timer = setInterval(() => {
      this.syncOnce().catch(e => this.log.warn(`Sync failed: ${e?.message || e}`));
    }, intervalMin * 60 * 1000);
  }

  // ---------- States ----------
  async ensureStates() {
    const defs = [
      ['meta.lastSync', 'number', 'Last sync timestamp (ms)'],
      ['meta.lastError', 'string', 'Last error message'],
      ['meta.captchaSrc', 'string', 'Captcha image URL (if required)'],

      // You already had more states in your older version; keep your existing ones if needed.
      // Minimal set here to prevent crashes:
    ];

    for (const [id, type, name] of defs) {
      await this.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role: 'value', read: true, write: false },
        native: {},
      });
    }
  }

  // ---------- Backoff logic ----------
  _scheduleBackoff(reason, suggestedMs) {
    // Increase backoff on repeated failures (cap at 6 hours)
    this.failCount = Math.min(this.failCount + 1, 10);
    this.lastFailReason = reason || 'unknown';

    // Base backoff grows with failCount: 5m, 10m, 20m, 40m... (cap)
    const base = Math.min(5 * 60 * 1000 * Math.pow(2, Math.max(0, this.failCount - 1)), 6 * 60 * 60 * 1000);
    const ms = Math.max(base, suggestedMs || 0);

    this.nextAllowedSyncTs = Date.now() + ms;

    const min = Math.ceil(ms / 60000);
    this.log.warn(`[Backoff] ${reason}. Next try in ~${min} min.`);
  }

  _clearBackoffOnSuccess() {
    this.failCount = 0;
    this.lastFailReason = '';
    this.nextAllowedSyncTs = 0;
  }

  // ---------- Main sync ----------
  async syncOnce() {
    // respect backoff window
    if (this.nextAllowedSyncTs && Date.now() < this.nextAllowedSyncTs) {
      const leftMs = this.nextAllowedSyncTs - Date.now();
      const leftMin = Math.ceil(leftMs / 60000);
      this.log.debug(`[Backoff] Skipping sync. Wait ${leftMin} min (reason: ${this.lastFailReason}).`);
      return;
    }

    try {
      await this.setStateAsync('meta.lastError', '', true);
      await this.setStateAsync('meta.captchaSrc', '', true);

      // 0) optional getData (can include tu/gu/au)
      const md = await this.eduClient.getLoginData().catch(() => null);

      // 1) token
      const tokRes = await this.eduClient.getToken({
        username: this.config.username,
        edupage: this.eduClient.school,
      });
      if (!tokRes?.token) {
        throw new Error(tokRes?.err?.error_text || 'No token');
      }

      // 2) login
      // Note: "ctxt" would be captcha text. We do NOT have UI field here yet, so keep empty.
      // When captcha is required, we stop and show captcha URL in log.
      const loginRes = await this.eduClient.login({
        username: this.config.username,
        password: this.config.password,
        userToken: tokRes.token,
        edupage: this.eduClient.school,
        ctxt: '', // no UI input yet
        tu: md?.tu ?? null,
        gu:
          md?.gu ??
          `/dashboard/eb.php?eqa=${encodeURIComponent(Buffer.from('mode=timetable').toString('base64'))}`,
        au: md?.au ?? null,
      });

      // 2a) captcha / suspicious activity detection
      if (loginRes?.needCaptcha == '1' || loginRes?.captchaSrc) {
        const src = loginRes.captchaSrc || '';
        const full = src.startsWith('http') ? src : `${this.eduHttp.baseUrl}${src}`;

        const msg =
          'Captcha nötig / verdächtige Aktivität erkannt. Öffne diese URL im Browser, gib das Passwort erneut ein und tippe den Text aus dem Bild ein: ' +
          full;

        // log + state
        this.log.error(msg);
        await this.setStateAsync('meta.lastError', msg, true);
        await this.setStateAsync('meta.captchaSrc', full, true);

        // Backoff (avoid triggering more captchas)
        this._scheduleBackoff('Captcha required by EduPage', 60 * 60 * 1000); // at least 60 min
        this.setState('info.connection', false, true);
        return;
      }

      if (loginRes?.status !== 'OK') {
        const errTxt = loginRes?.err?.error_text || 'Login failed';
        // if server complains about suspicious activity but without captchaSrc, still backoff
        if ((errTxt || '').toLowerCase().includes('verdächtig') || (errTxt || '').toLowerCase().includes('suspic')) {
          this._scheduleBackoff('Suspicious activity / extra verification', 60 * 60 * 1000);
        } else {
          this._scheduleBackoff(`Login failed: ${errTxt}`, 15 * 60 * 1000);
        }
        throw new Error(errTxt);
      }

      // 3) Timetable test call (only log keys for now)
      // If you want this to work reliably, you will eventually need:
      // - args (table + id + date range)
      // - _gsh token (often embedded in timetable page)
      // For now: just try to auto-detect gsh and call with empty args if you implement that later.
      // Here: keep it safe -> do nothing if you didn't implement args/gsh yet.

      this.setState('info.connection', true, true);
      await this.setStateAsync('meta.lastSync', Date.now(), true);

      // success => clear backoff
      this._clearBackoffOnSuccess();
    } catch (e) {
      const msg = String(e?.message || e);
      await this.setStateAsync('meta.lastError', msg, true);
      this.setState('info.connection', false, true);

      // Backoff on generic errors too (small)
      if (!this.nextAllowedSyncTs) {
        this._scheduleBackoff(`Error: ${msg}`, 10 * 60 * 1000);
      }

      throw e;
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
