# Security policy

## Reporting a vulnerability

Report security issues privately through [GitHub private vulnerability reporting](https://github.com/serkansokmen/Corbel/security/advisories/new). Please do not open a public issue for them. You should get a reply within 7 days.

Only the latest commit on `main` is supported; there are no maintained release branches yet.

## What Corbel is designed for

Corbel is a local tool for one user or a trusted LAN. Keep these points in mind when you deploy it:

- **The UI server has no login.** Anyone who can reach it can send queries, and it attaches the server-held `LAYA_API_KEY` to them. Bind it to `127.0.0.1` (the README's production command does) unless everyone on the network is trusted.
- **The backend requires a shared key for any non-loopback bind.** `setup-backend.ps1` generates a random one. The backend refuses the placeholder from `.backend.env.example`.
- **Traffic between the UI server and the backend is plain HTTP.** Use it on a trusted network or through a tunnel; do not expose port 5177 to the internet.
- **Documents stay in the browser's localStorage and are sent to the backend you configure.** Nothing is sent anywhere else. Model weights are downloaded from Hugging Face on first start; pin them with `LAYA_REVISION`.

Reports about these documented limits are still welcome when you find a way they fail worse than described.
