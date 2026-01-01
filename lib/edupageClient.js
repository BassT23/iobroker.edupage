'use strict';

const { EdupageHttp } = require('./edupageHttp');

class EdupageClient {
  /**
   * @param {{ http:any, baseUrl:string, log?:any }} opts
   */
  constructor({ http, baseUrl, log }) {
    this.http = new EdupageHttp({ http, baseUrl, log });
    this.log = log;
  }

  /**
   * Mirrors:
   * AscHttp.rpc('/login/?cmd=MainLogin', 'getToken', { username, edupage })
   */
  async getToken({ username, edupage }) {
    return this.http.rpc('/login/?cmd=MainLogin', 'getToken', {
      username,
      edupage,
    });
  }

  /**
   * Mirrors:
   * AscHttp.rpc('/login/?cmd=MainLogin', 'login', fd)
   * where fd contains username, password, userToken, edupage, ctxt, tu/gu/au
   */
  async login(fd) {
    return this.http.rpc('/login/?cmd=MainLogin', 'login', fd);
  }

  /**
   * Optional helper: after login, load the timetable page HTML
   * (still not JSON, but useful to discover next endpoints)
   */
  async openTimetableHtml() {
    return this.http.get('/dashboard/eb.php?mode=timetable');
  }
}

module.exports = { EdupageClient };
