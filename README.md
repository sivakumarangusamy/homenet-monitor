# HomeNet Monitor
A local-first home network monitoring dashboard: React + TypeScript, Express, SQLite, Socket.IO.

## Run
Requirements: Node.js 20+, npm, and the system `ping` command.

Terminal 1:
```bash
cd server
cp .env.example .env
npm install
npm run dev
```
Terminal 2:
```bash
cd client
npm install
npm run dev
```
Open http://localhost:5173. The backend listens on port 3001. It seeds `192.168.1.1` and `1.1.1.1` as example monitoring targets; edit/remove these if your network differs.

## Architecture
- React dashboard: live status cards, latency chart, target management, topology visualization, incident timeline.
- Express API: devices, check history, incidents.
- Monitoring worker: periodic ICMP checks and incident state changes.
- SQLite: persistent devices, checks, incidents.
- Socket.IO: live device updates.

## Limitations and safety
This MVP monitors only targets you configure; it does not automatically scan your LAN or capture traffic. Ping failures can be caused by ICMP filtering and do not prove an outage by themselves. The topology is a logical view, not automatic physical discovery. Keep it on your trusted LAN; authentication/TLS are not included, so do not port-forward it to the internet.
