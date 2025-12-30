# ioBroker EduPage Adapter

Dieser Adapter für **ioBroker** ruft **Stundenpläne und Vertretungen** aus **EduPage** ab und stellt sie als strukturierte States für Visualisierungen, Skripte und Automationen bereit.

> ⚠️ Hinweis: Der Adapter befindet sich aktuell in einem **frühen Entwicklungsstadium (0.x)**.  
> Die Datenstruktur ist stabil, die EduPage-API-Anbindung wird schrittweise ergänzt.

---

## ✨ Features

- 📅 Stundenplan für **heute** und **morgen**
- 🔔 Nächste Unterrichtsstunde (`next.*`)
- 🔄 Regelmäßige Aktualisierung (Intervall konfigurierbar)
- 🧠 Change-Erkennung per Hash
- 📊 VIS- & Skript-freundliches Datenmodell
- 🧩 Vorbereitung für Vertretungen & Ausfälle
- 👨‍👩‍👧 Erweiterbar für mehrere Kinder / Benutzer

---

## 📦 Installation

### Über GitHub (manuell)

```bash
cd /opt/iobroker
npm install iobroker.edupage
