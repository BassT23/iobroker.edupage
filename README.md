# ioBroker EduPage Adapter (edupage)

Fetch timetable and substitutions from EduPage.

> **Status:** Early development (0.0.x). The adapter may change without notice.

## Features

- Config via Admin UI (jsonConfig)
- Periodic sync (interval)
- Stores data in ioBroker states (today/tomorrow/next)

## Installation

### From GitHub (local dev)

```bash
cd /opt/iobroker
iobroker add https://github.com/BassT23/iobroker.edupage.git
```

From npm (planned)
Not published yet.

Configuration
Open ioBroker Admin → Instances → edupage → settings.

Base URL: e.g. https://myschool.edupage.org

Username / Password

Refresh interval (minutes)

Max lessons per day

Optional: week view / additional features (future)

States (overview)
The adapter creates states under:

edupage.0.meta.*

edupage.0.today.*

edupage.0.tomorrow.*

edupage.0.next.*

(Exact structure may evolve during 0.0.x.)

Development
Requirements
Node.js >= 20 recommended

ioBroker js-controller and admin should be up to date

## Changelog
0.0.1 - Initial working version with jsonConfig-based admin UI

## License
[MIT License. See LICENSE.](https://github.com/BassT23/ioBroker.edupage/tree/main#)

